import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import {
	actor as actorNative,
	type AnyActorDefinition,
	setup as setupNative,
	UserError,
} from "rivetkit";
import type * as Action from "./Action";
import { Client } from "./Client";
import * as RivetError from "./RivetError";

const TypeId = "~@rivetkit/effect/Actor";

export const isActor = (u: unknown): u is Actor<any, any> =>
	Predicate.hasProperty(u, TypeId);

/**
 * Display options carried by an actor contract.
 */
export interface Options {
	readonly name?: string;
	readonly icon?: string;
}

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
export interface Address {
	readonly actorId: string;
	readonly name: string;
	readonly key: ReadonlyArray<string>;
}

/**
 * Context tag for the current actor instance's `Address`. Provided
 * once per wake when the build effect runs; capture it into a
 * closure if action handlers need it.
 */
export class CurrentAddress extends Context.Service<CurrentAddress, Address>()(
	"@rivetkit/effect/Actor/CurrentAddress",
) {}

/**
 * One actor registered with the `Registry`. The `buildHandlers`
 * effect is run once per wake by the runner to construct
 * per-instance state and handlers; the handlers themselves are not
 * resolved at registration time.
 */
export interface RegistryEntry {
	readonly actor: AnyWithProps;
	readonly buildHandlers: Effect.Effect<unknown, never, unknown>;
}

export interface RegistryShape {
	readonly engineOptions: EngineOptions;
	readonly register: (entry: RegistryEntry) => Effect.Effect<void>;
	readonly entries: Effect.Effect<ReadonlyArray<RegistryEntry>>;
}

export interface RunnerShape {
	readonly mode: "start" | "serve" | "handler" | "startEnvoy" | "test";
}

/**
 * Connection options for the Rivet Engine.
 *
 * Mirrors the engine wiring used by the non-Effect TS SDK: an optional
 * endpoint (with URL-auth syntax for namespace and token), plus
 * standalone `token` and `namespace` fields. All fields are optional
 * and fall back to the matching `RIVET_*` environment variables.
 */
export interface EngineOptions {
	/**
	 * Endpoint URL of the Rivet Engine.
	 *
	 * Supports URL auth syntax for namespace and token:
	 * - `https://namespace:token@api.rivet.dev`
	 * - `https://namespace@api.rivet.dev`
	 *
	 * Falls back to `RIVET_ENDPOINT`.
	 */
	readonly endpoint?: string;
	/** Auth token. Falls back to `RIVET_TOKEN`. */
	readonly token?: string;
	/**
	 * Namespace. Falls back to `RIVET_NAMESPACE`, then `"default"`.
	 */
	readonly namespace?: string;
}

export interface RegistryOptions extends EngineOptions {}

/**
 * Service collecting actor defs/builders together with the engine
 * connection config. Provided once via `Registry.layer({ ... })` and
 * consumed by both `Actor.toLayer` (which registers itself into the
 * collector on acquire) and the `Runner.*` mode layers (which
 * materialize the underlying rivetkit registry from the collected
 * entries).
 */
export class Registry extends Context.Service<Registry, RegistryShape>()(
	"@rivetkit/effect/Actor/Registry",
) {
	static layer(options: RegistryOptions = {}): Layer.Layer<Registry> {
		const engineOptions: EngineOptions = {
			endpoint: options.endpoint,
			token: options.token,
			namespace: options.namespace,
		};
		return Layer.effect(
			Registry,
			Effect.gen(function* () {
				const ref = yield* Ref.make<ReadonlyArray<RegistryEntry>>([]);
				return Registry.of({
					engineOptions,
					register: (entry) =>
						Ref.update(ref, (xs) => [...xs, entry]),
					entries: Ref.get(ref),
				});
			}),
		);
	}
}

const runnerNotImplemented = (
	mode: RunnerShape["mode"],
): Layer.Layer<Runner, never, Registry> =>
	Layer.effect(
		Runner,
		Effect.gen(function* () {
			yield* Registry;
			throw new Error(
				`Runner.${mode} is not yet implemented. Server runtime wiring is pending.`,
			);
		}),
	);

type ActorInstance = {
	readonly handlers: Record<
		string,
		(req: {
			readonly _tag: string;
			readonly action: Action.AnyWithProps;
			readonly payload: unknown;
		}) => Effect.Effect<unknown, unknown>
	>;
	readonly scope: Scope.Closeable;
};

const buildNativeActor = (
	entry: RegistryEntry,
	instances: Map<string, ActorInstance>,
	runHandler: <A>(effect: Effect.Effect<A, unknown, unknown>) => Promise<A>,
): AnyActorDefinition => {
	const actor = entry.actor;
	const decoders = new Map<
		string,
		(v: unknown) => Effect.Effect<unknown, unknown, unknown>
	>();
	const encoders = new Map<
		string,
		(v: unknown) => Effect.Effect<unknown, unknown, unknown>
	>();
	for (const action of actor.actions) {
		decoders.set(
			action._tag,
			Schema.decodeUnknownEffect(action.payloadSchema) as never,
		);
		encoders.set(
			action._tag,
			Schema.encodeUnknownEffect(action.successSchema) as never,
		);
	}

	const actions: Record<
		string,
		(c: { actorId: string }, payload?: unknown) => Promise<unknown>
	> = {};
	for (const action of actor.actions) {
		const tag = action._tag;
		actions[tag] = async (c, payload) => {
			const inst = instances.get(c.actorId);
			if (!inst) {
				throw new Error(
					`actor ${actor._tag}/${c.actorId} has no handlers (onWake didn't run?)`,
				);
			}
			const handler = inst.handlers[tag];
			if (!handler) {
				throw new Error(
					`actor ${actor._tag} has no handler for action ${tag}`,
				);
			}
			const decoded = await runHandler(decoders.get(tag)!(payload));
			// Wrap the handler so typed failures (matching `errorSchema`)
			// are encoded and thrown across the wire as a rivetkit
			// `UserError`. The error class's `_tag` becomes the wire
			// `code`, the encoded shape rides in `metadata`. Failures that
			// don't match the schema fall through and surface as a
			// generic infra error.
			const handlerEffect = handler({
				_tag: tag,
				action,
				payload: decoded,
			}).pipe(
				Effect.catch((typedErr) =>
					Schema.encodeUnknownEffect(action.errorSchema)(
						typedErr,
					).pipe(
						Effect.matchEffect({
							onSuccess: (encoded) =>
								Effect.die(
									new UserError(
										(typedErr as { message?: string })
											?.message ?? `${tag} failed`,
										{
											code:
												(typedErr as { _tag?: string })
													?._tag ?? tag,
											metadata: encoded,
										},
									),
								),
							onFailure: () => Effect.fail(typedErr),
						}),
					),
				),
			);
			const result = await runHandler(handlerEffect);
			return await runHandler(encoders.get(tag)!(result));
		};
	}

	return actorNative({
		actions,
		options: actor.options,
		onWake: async (c: {
			actorId: string;
			name: string;
			key: ReadonlyArray<string>;
		}) => {
			const address: Address = {
				actorId: c.actorId,
				name: c.name,
				key: c.key,
			};
			const scope = await runHandler(Scope.make());
			const built = entry.buildHandlers as Effect.Effect<
				unknown,
				never,
				Scope.Scope | CurrentAddress
			>;
			const withAddress = Effect.provideService(
				built,
				CurrentAddress,
				address,
			);
			const withScope = Effect.provideService(
				withAddress,
				Scope.Scope,
				scope,
			);
			const handlers = await runHandler(
				withScope as Effect.Effect<unknown, never, never>,
			);
			instances.set(c.actorId, {
				handlers: handlers as ActorInstance["handlers"],
				scope,
			});
		},
		onSleep: async (c: { actorId: string }) => {
			const inst = instances.get(c.actorId);
			if (!inst) return;
			instances.delete(c.actorId);
			await runHandler(Scope.close(inst.scope, Exit.void));
		},
	} as Parameters<typeof actorNative>[0]);
};

/**
 * Service that selects how the registered actors are served. Each
 * static field is a `Layer` for a specific mode mirroring the
 * non-Effect TS SDK: `start`, `serve`, `handler`, `startEnvoy`, plus a
 * `test` mode for in-process testing. Each requires `Registry`.
 */
export class Runner extends Context.Service<Runner, RunnerShape>()(
	"@rivetkit/effect/Actor/Runner",
) {
	static start: Layer.Layer<Runner, never, Registry> = Layer.effect(
		Runner,
		Effect.gen(function* () {
			const registry = yield* Registry;
			const entries = yield* registry.entries;

			// Snapshot the current Effect context so action callbacks
			// (which run in rivetkit's plain Promise world) can run
			// handler effects against the same services Runner.start
			// was provided with.
			const context = yield* Effect.context();
			const runHandler = <A>(
				effect: Effect.Effect<A, unknown, unknown>,
			): Promise<A> =>
				Effect.runPromiseWith(context)(
					effect as Effect.Effect<A, unknown, never>,
				);

			const instances = new Map<string, ActorInstance>();
			const use: Record<string, AnyActorDefinition> = {};
			for (const entry of entries) {
				use[entry.actor._tag] = buildNativeActor(
					entry,
					instances,
					runHandler,
				);
			}

			const native = setupNative({
				use,
				endpoint: registry.engineOptions.endpoint,
				token: registry.engineOptions.token,
				namespace: registry.engineOptions.namespace,
			});
			yield* Effect.sync(() => native.start());
			return Runner.of({ mode: "start" });
		}),
	);
	static serve: Layer.Layer<Runner, never, Registry> =
		runnerNotImplemented("serve");
	static handler: Layer.Layer<Runner, never, Registry> =
		runnerNotImplemented("handler");
	static startEnvoy: Layer.Layer<Runner, never, Registry> =
		runnerNotImplemented("startEnvoy");
	static test: Layer.Layer<Runner, never, Registry> =
		runnerNotImplemented("test");
}

export type ActionRequest<A extends Action.AnyWithProps> =
	A extends Action.Action<infer Tag, infer Payload, infer _Success, infer _Error>
		? {
				readonly _tag: Tag;
				readonly action: A;
				readonly payload: Payload["Type"];
			}
		: never;

export type ActionHandlers<Actions extends Action.AnyWithProps> = {
	readonly [A in Actions as Action.Tag<A>]: (
		request: ActionRequest<A>,
	) => Effect.Effect<Action.Success<A>, Action.Error<A>, unknown>;
};

type HandlerServices<Handlers> = {
	readonly [Name in keyof Handlers]: Handlers[Name] extends (
		...args: ReadonlyArray<any>
	) => Effect.Effect<any, any, infer R>
		? R
		: never;
}[keyof Handlers];

export type ActorKey = string | ReadonlyArray<string>;

/**
 * A typed handle for one actor instance. Each action becomes a
 * method that takes the action's payload-constructor input and
 * returns an Effect with the action's success / typed error
 * channels baked in.
 */
export type Handle<Actions extends Action.AnyWithProps> = {
	readonly [A in Actions as Action.Tag<A>]: (
		payload: Action.PayloadConstructor<A>,
	) => Effect.Effect<
		Action.Success<A>,
		Action.Error<A> | RivetError.RivetError,
		never
	>;
};

/**
 * Yielded by `Actor.client`. Address an actor instance by key, then
 * dispatch typed action calls against the returned `Handle`.
 */
export interface TypedAccessor<Actions extends Action.AnyWithProps> {
	readonly getOrCreate: (key: ActorKey) => Handle<Actions>;
}

/**
 * A Rivet Actor contract. It carries the action schemas and
 * display options, but no server implementation.
 */
export interface Actor<
	Name extends string,
	Actions extends Action.AnyWithProps = never,
> {
	readonly [TypeId]: typeof TypeId;
	readonly _tag: Name;
	readonly key: string;
	readonly actions: ReadonlyArray<Actions>;
	readonly options: Options;

	of<Handlers extends ActionHandlers<Actions>>(handlers: Handlers): Handlers;

	toLayer<Handlers extends ActionHandlers<Actions>, RX = never>(
		build: Handlers | Effect.Effect<Handlers, never, RX>,
	): Layer.Layer<
		never,
		never,
		| Exclude<RX, Scope.Scope | CurrentAddress>
		| HandlerServices<Handlers>
		| Action.ServicesServer<Actions>
		| Action.ServicesClient<Actions>
		| Registry
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
		Client | Action.ServicesClient<Actions>
	>;
}

/**
 * Type-erased view of any actor contract.
 */
export interface Any {
	readonly [TypeId]: typeof TypeId;
	readonly _tag: string;
	readonly key: string;
}

/**
 * Type-erased actor with all runtime properties available.
 */
export interface AnyWithProps extends Actor<string, Action.AnyWithProps> {}

export type Name<A> = A extends Actor<infer _Name, any> ? _Name : never;

export type Actions<A> = A extends Actor<any, infer _Actions> ? _Actions : never;

export type Services<A> = A extends Actor<any, infer _Actions>
	? Action.Services<_Actions>
	: never;

export type ClientServices<A> = A extends Actor<any, infer _Actions>
	? Action.ServicesClient<_Actions>
	: never;

export type ServerServices<A> = A extends Actor<any, infer _Actions>
	? Action.ServicesServer<_Actions>
	: never;

const identity = <A>(value: A): A => value;

const Proto = {
	[TypeId]: TypeId,
	of: identity,
	toLayer(this: AnyWithProps, build: unknown) {
		const self = this;
		const buildHandlers = (
			Effect.isEffect(build) ? build : Effect.succeed(build)
		) as Effect.Effect<unknown, never, unknown>;
		return Layer.effectDiscard(
			Effect.gen(function* () {
				const registry = yield* Registry;
				yield* registry.register({
					actor: self,
					buildHandlers,
				});
			}),
		);
	},
	get client() {
		const self = this as unknown as AnyWithProps;
		return Effect.gen(function* () {
			const client = yield* Client;
			const actions = self.actions;
			return {
				getOrCreate: (key: ActorKey) => {
					const handle: Record<
						string,
						(p: unknown) => Effect.Effect<unknown, unknown, never>
					> = {};
					for (const action of actions) {
						const tag = action._tag;
						handle[tag] = (payload) =>
							Effect.gen(function* () {
								const encoded = yield* Schema.encodeUnknownEffect(
									action.payloadSchema,
								)(payload);
								const raw = yield* client
									.callAction({
										actorName: self._tag,
										key,
										actionName: tag,
										encodedPayload: encoded,
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
							}) as Effect.Effect<unknown, unknown, never>;
					}
					return handle as Handle<Action.AnyWithProps>;
				},
			};
		});
	},
};

const makeProto = <
	const Name extends string,
	Actions extends Action.AnyWithProps,
>(options: {
	readonly _tag: Name;
	readonly actions: ReadonlyArray<Actions>;
	readonly options: Options;
}): Actor<Name, Actions> => {
	const key = `@rivetkit/effect/Actor/${options._tag}`;
	return Object.assign(Object.create(Proto), {
		...options,
		key,
	}) as Actor<Name, Actions>;
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
		readonly options?: Options;
	},
): Actor<Name, Actions[number]> => {
	return makeProto({
		_tag: name,
		actions: (options?.actions ?? []) as ReadonlyArray<Action.AnyWithProps>,
		options: options?.options ?? {},
	}) as any;
};
