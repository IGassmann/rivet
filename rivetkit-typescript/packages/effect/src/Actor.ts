import {
	Context,
	Effect,
	identity,
	Layer,
	Predicate,
	Schema,
	Scope,
} from "effect";
import * as Rivetkit from "rivetkit";
import * as Registry from './Registry';
import type * as Action from "./Action";
import type * as ActorState from "./ActorState";
import * as Client from "./Client";
import * as RivetError from "./RivetError";
import { rpcSystem } from "./internal/tracing";

const TypeId = "~@rivetkit/effect/Actor";

export const isActor = (u: unknown): u is Actor<any, any> =>
	Predicate.hasProperty(u, TypeId);

export type RivetkitActorOptions = Pick<
	NonNullable<Rivetkit.ActorOptionsInput>,
	"name" | "icon"
>;

/**
 * Per-actor instance options. Combines the public
 * `RivetkitActorOptions` (forwarded verbatim to `Rivetkit.actor`)
 * with the effect-SDK-only options.
 */
export type Options<State extends ActorState.AnyWithProps> =
	Readonly<RivetkitActorOptions> & {
		readonly state?: State;
	};

export const splitOptions = <State extends ActorState.AnyWithProps>(
	options: Options<State>,
): {
	readonly rivetkitOptions: RivetkitActorOptions;
	readonly effectOptions: Omit<
		Options<State>,
		keyof RivetkitActorOptions
	>;
} => {
	const { state, ...rivetkitOptions } = options;
	return { rivetkitOptions, effectOptions: { state } };
};

/**
 * Per-instance identity carried inside the wake scope. An actor
 * instance is addressable in two ways:
 *
 * - `(name, key)` — stable user-facing pair (e.g. "Counter", ["counter-123"])
 * - `actorId` — opaque engine-assigned unique identifier
 *
 * Available inside `Actor.toLayer`'s build effect via
 * `yield* Actor.CurrentAddress`.
 */
export type ActorAddress = Pick<
	Rivetkit.ActorContext<any, any, any, any, any, any, any, any>,
	"actorId" | "name" | "key"
>;

/**
 * Context tag for the current actor instance's address. Provided
 * once per wake when the build effect runs; capture it into a
 * closure if action handlers need it.
 */
export class CurrentAddress extends Context.Service<
	CurrentAddress,
	ActorAddress
>()("@rivetkit/effect/Actor/CurrentAddress") {}

export class Sleep extends Context.Service<Sleep, Effect.Effect<void>>()(
	"@rivetkit/effect/Actor/Sleep",
) {}

export type ActionRequest<A extends Action.Any> =
	A extends Action.Action<
		infer Tag,
		infer Payload,
		infer _Success,
		infer _Error
	>
		? {
				readonly _tag: Tag;
				readonly action: A;
				readonly payload: Payload["Type"];
			}
		: never;

type HandlerServices<Handlers> = {
	readonly [Name in keyof Handlers]: Handlers[Name] extends (
		...args: ReadonlyArray<any>
	) => Effect.Effect<any, any, infer R>
		? R
		: never;
}[keyof Handlers];

export type ActorKeyParam = string | Rivetkit.ActorKey;

/**
 * A typed handle for one actor instance. Each action becomes a
 * method that takes the action's payload-constructor input and
 * returns an Effect with the action's success / typed error
 * channels baked in.
 */
export type Handle<Actions extends Action.Any> = {
	readonly [A in Actions as Action.Tag<A>]: (
		payload: Action.PayloadConstructor<A>,
	) => Effect.Effect<
		Action.Success<A>,
		Action.Error<A> | RivetError.RivetError
	>;
};

/**
 * Yielded by `Actor.client`. Address an actor instance by key, then
 * dispatch typed action calls against the returned `Handle`.
 */
export interface TypedAccessor<Actions extends Action.Any> {
	readonly getOrCreate: (key: ActorKeyParam) => Handle<Actions>;
}

/**
 * A Rivet Actor contract. It carries the action schemas and
 * display options, but no server implementation.
 */
export interface Actor<
	in out Name extends string,
	in out Actions extends Action.Any = never,
> {
	readonly [TypeId]: typeof TypeId;
	readonly name: Name;
	readonly actions: ReadonlyArray<Actions>;

	of<Handlers extends HandlersFrom<Actions>>(handlers: Handlers): Handlers;

	toLayer<
		Handlers extends HandlersFrom<Actions>,
		State extends ActorState.AnyWithProps = never,
		RX = never,
	>(
		build: Handlers | Effect.Effect<Handlers, never, RX>,
		options?: Options<State>,
	): Layer.Layer<
		never,
		never,
		| Exclude<RX, Scope.Scope | CurrentAddress | Sleep | State>
		| HandlerServices<Handlers>
		| Action.ServicesServer<Actions>
		| Action.ServicesClient<Actions>
		| Registry.Registry
	>;

	/**
	 * Effect-yielded typed accessor for this actor. Provide a
	 * `Client.layer({ ... })` once at the program root; every
	 * `yield* SomeActor.client` then dispatches through the same
	 * transport. Per-call signatures are `Effect<Success, Error |
	 * RivetError, never>` — schema services are pulled in at the
	 * getter level via `Action.ServicesClient<Actions>`.
	 */
	readonly client: Effect.Effect<
		TypedAccessor<Actions>,
		never,
		Client.Client | Action.ServicesClient<Actions>
	>;
}

export type Any = Actor<string, Action.AnyWithProps>;

export type HandlersFrom<Action extends Action.Any> = {
	readonly [Current in Action as Current["_tag"]]: (
		envelope: ActionRequest<Current>,
	) => Action.ResultFrom<Current, any>;
};

const Proto: Omit<Actor<any, any>, "name" | "actions"> = {
	[TypeId]: TypeId,
	toLayer<
		Actions extends Action.Any,
		Handlers extends HandlersFrom<Actions>,
		State extends ActorState.AnyWithProps = never,
		RX = never,
	>(
		this: Actor<string, Actions>,
		build: Handlers | Effect.Effect<Handlers, never, RX>,
		options?: Options<State>,
	) {
		return Registry.Registry.asEffect().pipe(
			Effect.flatMap((registry) =>
				registry.register({
					actor: this,
					buildHandlers: Effect.isEffect(build)
						? build
						: Effect.succeed(build),
					options,
				})
			),
			Layer.effectDiscard
		)
	},
	get client() {
		const self = this as Any;
		return Effect.gen(function* () {
			const client = yield* Client.Client;
			const actions = self.actions;
			return {
				getOrCreate: (key: ActorKeyParam) => {
					const handle: Record<
						string,
						(p: unknown) => Effect.Effect<unknown, unknown>
					> = {};
					for (const action of actions) {
						const tag = action._tag;
						const rpcMethod = `${self.name}/${tag}`;
						// `Effect.fn` wraps the generator in a span named
						// `rpcMethod` (kind=client + OTel `rpc.*` attrs)
						// without an extra `pipe(Effect.withSpan(...))`.
						// The active span inside is the one whose IDs
						// the body reads via `Effect.currentSpan` and
						// ships as `meta.trace`, so the server-side
						// wrapper can reattach it as the handler's
						// parent. Same pattern as Effect's RPC layer
						// (`RpcClient.ts`).
						handle[tag] = Effect.fn(rpcMethod, {
							kind: "client",
							attributes: {
								"rpc.system.name": rpcSystem,
								"rpc.method": rpcMethod,
							},
						})(function* (payload: unknown) {
							const encoded = yield* Schema.encodeUnknownEffect(
								action.payloadSchema,
							)(payload);
							const span = yield* Effect.currentSpan;
							const meta: Client.ActionMeta = {
								trace: {
									traceId: span.traceId,
									spanId: span.spanId,
									sampled: span.sampled,
								},
							};
							const raw = yield* client
								.callAction({
									actorName: self.name,
									key,
									actionName: tag,
									encodedPayload: encoded,
									meta,
								})
								.pipe(
									// Try `errorSchema` first against the
									// wire metadata. Fall back to wrapping
									// the raw RivetError via `RivetErrorFromWire`.
									Effect.catch((rivetErr) =>
										Schema.decodeUnknownEffect(
											action.errorSchema,
										)(
											(rivetErr as { metadata?: unknown })
												.metadata,
										).pipe(
											Effect.matchEffect({
												onSuccess: (typed) =>
													Effect.fail(typed),
												onFailure: () =>
													Schema.decodeUnknownEffect(
														RivetError.RivetErrorFromWire,
													)({
														group: rivetErr.group,
														code: rivetErr.code,
														message:
															rivetErr.message,
														metadata: (
															rivetErr as {
																metadata?: unknown;
															}
														).metadata,
													}).pipe(
														Effect.flatMap(
															Effect.fail,
														),
													),
											}),
										),
									),
								);
							return yield* Schema.decodeUnknownEffect(
								action.successSchema,
							)(raw);
						}) as (p: unknown) => Effect.Effect<unknown, unknown>;
					}
					return handle as Handle<Action.AnyWithProps>;
				},
			};
		});
	},
	of: identity,
};

/**
 * Define a Rivet Actor contract.
 */
export const make = <
	const Name extends string,
	const Actions extends ReadonlyArray<Action.AnyWithProps> = readonly [],
>(
	name: Name,
	options?: {
		readonly actions?: Actions;
	},
): Actor<Name, Actions[number]> => {
	const self = Object.create(Proto);
	self.name = name;
	self.actions = options?.actions;
	return self;
};
