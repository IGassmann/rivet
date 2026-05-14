import {
	Context,
	Effect,
	identity,
	Layer,
	Predicate,
	Schema,
	Scope,
	Struct,
	Record,
	MutableHashMap,
	Option,
	Tracer,
	Exit,
	Cause,
	Semaphore,
} from "effect";
import * as Rivetkit from "rivetkit";
import type * as RivetkitDb from "rivetkit/db";
import { hasStringProperty } from "./utils";
import * as Registry from "./Registry";
import type * as Action from "./Action";
import type * as ActorState from "./ActorState";
import * as Client from "./Client";
import * as State from "./State";
import * as RivetError from "./RivetError";
import { readTraceMeta, rpcSystem } from "./internal/tracing";

const TypeId = "~@rivetkit/effect/Actor";

const decodeRivetErrorFromWire = Schema.decodeUnknownEffect(
	RivetError.RivetErrorFromWire,
);

export const isActor = (u: unknown): u is Actor<any, any> =>
	Predicate.hasProperty(u, TypeId);

const rivetkitActorOptionsKeys = [
	"name",
	"icon",
] as const satisfies ReadonlyArray<
	keyof NonNullable<Rivetkit.ActorOptionsInput>
>;

export type RivetkitActorOptions = Pick<
	NonNullable<Rivetkit.ActorOptionsInput>,
	(typeof rivetkitActorOptionsKeys)[number]
>;

/**
 * Per-actor instance options. Combines the public
 * `RivetkitActorOptions` (forwarded verbatim to `Rivetkit.actor`)
 * with the effect-SDK-only options.
 */
export type Options<State extends ActorState.AnyWithProps> =
	Readonly<RivetkitActorOptions> & {
		readonly state?: State;
		readonly db?: RivetkitDb.AnyDatabaseProvider;
	};

const splitOptions = <State extends ActorState.AnyWithProps>(
	options: Options<State>,
) => ({
	rivetkitOptions: Struct.pick(options, rivetkitActorOptionsKeys),
	effectOptions: Struct.omit(options, rivetkitActorOptionsKeys),
});

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

export class RivetkitContext extends Context.Service<
	RivetkitContext,
	Rivetkit.RunContextOf<Rivetkit.AnyActorDefinition>
>()("@rivetkit/effect/Actor/RivetkitContext") {}

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

type ActionHandlerServices<ActionHandlers> = {
	readonly [Name in keyof ActionHandlers]: ActionHandlers[Name] extends (
		...args: ReadonlyArray<any>
	) => Effect.Effect<any, any, infer R>
		? R
		: never;
}[keyof ActionHandlers];

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

	of<ActionHandlers extends ActionHandlersFrom<Actions>>(
		actionHandlers: ActionHandlers,
	): ActionHandlers;

	toLayer<
		ActionHandlers extends ActionHandlersFrom<Actions>,
		State extends ActorState.AnyWithProps = never,
		RX = never,
	>(
		build: ActionHandlers | Effect.Effect<ActionHandlers, never, RX>,
		options?: Options<State>,
	): Layer.Layer<
		never,
		never,
		| Exclude<
				RX,
				Scope.Scope | CurrentAddress | Sleep | RivetkitContext | State
		  >
		| ActionHandlerServices<ActionHandlers>
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

export type ActionHandlersFrom<Actions extends Action.Any> = {
	readonly [Action in Actions as Action["_tag"]]: (
		envelope: ActionRequest<Action>,
	) => Action.ResultFrom<Action, any>;
};

const Proto: Omit<Actor<any, any>, "name" | "actions"> = {
	[TypeId]: TypeId,
	toLayer<
		Actions extends Action.AnyWithProps,
		ActionHandlers extends ActionHandlersFrom<Actions>,
		State extends ActorState.AnyWithProps = never,
		RX = never,
	>(
		this: Actor<string, Actions>,
		build: ActionHandlers | Effect.Effect<ActionHandlers, never, RX>,
		options: Options<State> = {},
	) {
		return makeRivetkitActor({
			actor: this,
			buildActionHandlers: Effect.isEffect(build)
				? build
				: Effect.succeed(build),
			options,
		}).pipe(
			Effect.flatMap((rivetKitActor) =>
				Registry.Registry.asEffect().pipe(
					Effect.flatMap((registry) =>
						Effect.sync(() =>
							registry.rivetkitActors.set(
								this.name,
								rivetKitActor,
							),
						),
					),
				),
			),
			Layer.effectDiscard,
		);
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
						const encodePayload = Schema.encodeUnknownEffect(
							action.payloadSchema,
						);
						const decodeSuccess = Schema.decodeUnknownEffect(
							action.successSchema,
						);
						const decodeError = Schema.decodeUnknownEffect(
							action.errorSchema,
						);
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
									encodedPayload:
										yield* encodePayload(payload),
									meta,
								})
								.pipe(
									// Try `errorSchema` first against the
									// wire metadata. Fall back to wrapping
									// the raw RivetError via `RivetErrorFromWire`.
									Effect.catch((rivetErr) =>
										decodeError(
											(rivetErr as { metadata?: unknown })
												.metadata,
										).pipe(
											Effect.matchEffect({
												onSuccess: (typed) =>
													Effect.fail(typed),
												onFailure: () =>
													decodeRivetErrorFromWire({
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
							return yield* decodeSuccess(raw);
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

const makeRivetkitActor = Effect.fnUntraced(function* <
	Name extends string,
	Actions extends Action.AnyWithProps,
	ActionHandlers extends ActionHandlersFrom<Actions>,
	RX,
	State extends ActorState.AnyWithProps = never,
>({
	actor,
	buildActionHandlers,
	options,
}: {
	readonly actor: Actor<Name, Actions>;
	readonly buildActionHandlers: Effect.Effect<ActionHandlers, never, RX>;
	readonly options: Options<State>;
}) {
	// Snapshot the current Effect context so action callbacks
	// (which run in rivetkit's plain Promise world) can run
	// handler effects against the same services the Registry.start /
	// Registry.test layer was provided with.
	const services = yield* Effect.context<any>();

	const { effectOptions, rivetkitOptions } = splitOptions(options);
	const stateDefOption = Option.fromNullishOr(effectOptions.state);
	const stateCodec = Option.map(stateDefOption, (def) => ({
		decode: Schema.decodeUnknownEffect(def.schema),
		encode: Schema.encodeUnknownEffect(def.schema),
	}));

	const instances = MutableHashMap.empty<
		string,
		{
			readonly actionHandlers: ActionHandlers;
			readonly scope: Scope.Closeable;
			readonly state: Option.Option<
				State.State<State["schema"]["Type"], Schema.SchemaError>
			>;
		}
	>();

	const onWake = async (
		c: Rivetkit.WakeContextOf<Rivetkit.AnyActorDefinition>,
	) => {
		await Effect.runPromiseWith(services)(
			Effect.gen(function* () {
				const scope = yield* Scope.make();

				const state = Option.isSome(stateCodec)
					? Option.some(
							// `c.state` IS the state — `State` is just a typed
							// view + change stream over it. Effect-typed
							// read/write so async schema transforms work,
							// and `SchemaError` flows through `State.get` /
							// `set` / `update` to action handlers. The
							// wake-time initial read still dies if persisted
							// state can't be decoded — no caller exists yet
							// to handle it. `Schema.Top`'s requirements show
							// up as `unknown`; the captured `services`
							// context satisfies them at runtime, so we erase
							// R at the boundary.
							(yield* State.make(
								() => stateCodec.value.decode(c.state),
								(next) =>
									stateCodec.value.encode(next).pipe(
										Effect.tap((encoded) =>
											Effect.sync(() => {
												c.state = encoded;
											}),
										),
										Effect.asVoid,
									),
							).pipe(Effect.orDie)) as State.State<
								ActorState.AnyWithProps["schema"]["Type"],
								Schema.SchemaError
							>,
						)
					: Option.none();

				const context = Context.mergeAll(
					Context.make(CurrentAddress, {
						actorId: c.actorId,
						name: c.name,
						key: c.key,
					}),
					Context.make(Scope.Scope, scope),
					Context.make(
						Sleep,
						Effect.sync(() => c.sleep()),
					),
					Context.make(RivetkitContext, c),
					Option.match(state, {
						onNone: () => Context.empty(),
						onSome: (s) =>
							Context.make(Option.getOrThrow(stateDefOption), s),
					}),
				);

				const actionHandlers = yield* buildActionHandlers.pipe(
					Effect.provide(context),
				);

				yield* Effect.sync(() =>
					MutableHashMap.set(instances, c.actorId, {
						actionHandlers,
						scope,
						state,
					}),
				);
			}),
		);
	};

	const actions = Record.fromIterableWith(actor.actions, (action) => {
		const decodePayload = Schema.decodeUnknownEffect(action.payloadSchema);
		const encodeSuccess = Schema.encodeUnknownEffect(action.successSchema);
		const encodeError = Schema.encodeUnknownEffect(action.errorSchema);
		return [
			action._tag,
			async (
				c: Rivetkit.ActionContextOf<Rivetkit.AnyActorDefinition>,
				payload: Action.Payload<typeof action>,
				meta?: Client.ActionMeta, // TODO: Find better type
			) => {
				// Always wrap in a server-side span so the handler has a
				// live `currentSpan` even when the caller didn't ship trace
				// context (e.g. a non-Effect-SDK client). When trace context
				// is present, reattach it as the parent so the server span
				// joins the caller's trace.
				const rpcMethod = `${actor.name}/${action._tag}`;
				const traceMeta = readTraceMeta(meta);

				const exit = await Effect.runPromiseExitWith(services)(
					Effect.gen(function* () {
						const instance = yield* MutableHashMap.get(
							instances,
							c.actorId,
						).pipe(Effect.fromOption, Effect.orDie);
						// The handler map is keyed by the same action
						// definitions being registered here, but
						// TypeScript loses that relationship once the
						// actions are widened into the RivetKit actions
						// record.
						const actionHandler = instance.actionHandlers[
							action._tag as keyof ActionHandlers
						] as (
							envelope: ActionRequest<typeof action>,
						) => Action.ResultFrom<typeof action, any>;
						const decoded = yield* decodePayload(payload).pipe(
							Effect.orDie,
						);
						// The payload was decoded with this action's schema,
						// so this is the runtime boundary that restores the
						// typed envelope expected by the user handler.
						const actionRequest = {
							_tag: action._tag,
							action,
							payload: decoded,
						} as ActionRequest<typeof action>;
						const result = yield* actionHandler(actionRequest).pipe(
							Effect.catch((expectedError) =>
								Effect.gen(function* () {
									const error = yield* encodeError(
										expectedError,
									).pipe(Effect.orDie);
									return yield* Effect.die(
										new Rivetkit.UserError(
											hasStringProperty("message")(error)
												? error.message
												: `${action._tag} failed`,
											{
												code: hasStringProperty("_tag")(
													error,
												)
													? error._tag
													: undefined,
												metadata: error,
											},
										),
									);
								}),
							),
						);
						return yield* encodeSuccess(result).pipe(Effect.orDie);
					}).pipe(
						Effect.withSpan(rpcMethod, {
							parent: traceMeta
								? Tracer.externalSpan(traceMeta)
								: undefined,
							kind: "server",
							attributes: {
								"rpc.system.name": rpcSystem,
								"rpc.method": rpcMethod,
							},
						}),
					),
				);

				if (Exit.isSuccess(exit)) return exit.value;
				throw Cause.squash(exit.cause);
			},
		];
	});

	const onStateChange = (
		c: Rivetkit.WakeContextOf<Rivetkit.AnyActorDefinition>,
		newState: unknown,
	) => {
		void Effect.runForkWith(services)(
			Effect.gen(function* () {
				if (Option.isNone(stateCodec)) return;

				const instance = yield* MutableHashMap.get(
					instances,
					c.actorId,
				).pipe(Effect.fromOption, Effect.orDie);

				if (Option.isNone(instance.state)) return;

				const stateRef = instance.state.value;
				yield* Semaphore.withPermit(
					stateRef.semaphore,
					Effect.gen(function* () {
						const decoded = yield* stateCodec.value
							.decode(newState)
							.pipe(Effect.orDie);
						State.publishUnsafe(stateRef, decoded);
					}),
				);
			}),
		);
	};

	const onSleep = async (
		c: Rivetkit.SleepContextOf<Rivetkit.AnyActorDefinition>,
	) => {
		await Effect.runPromiseWith(services)(
			Effect.gen(function* () {
				const instance = yield* MutableHashMap.get(
					instances,
					c.actorId,
				).pipe(Effect.fromOption, Effect.orDie);
				yield* Scope.close(instance.scope, Exit.void);
				yield* Effect.sync(() => {
					MutableHashMap.remove(instances, c.actorId);
				});
			}),
		);
	};

	return Rivetkit.actor({
		options: rivetkitOptions,
		...(effectOptions.db ? { db: effectOptions.db } : {}),
		onWake,
		...(Option.isSome(stateDefOption)
			? {
					createState: () =>
						Option.getOrThrow(stateCodec)
							.encode(stateDefOption.value.initialValue())
							.pipe(Effect.orDie),
				}
			: {}),
		actions,
		onStateChange,
		onSleep,
	});
});
