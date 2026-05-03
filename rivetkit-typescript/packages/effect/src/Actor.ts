import {
	Cause,
	Context,
	Effect,
	Exit,
	Layer,
	Predicate,
	Ref,
	Schema,
	Scope,
} from "effect";
import * as Rivetkit from "rivetkit";
import * as RivetkitClient from "rivetkit/client";
import type * as Action from "./Action";
import { Client, type ClientService } from "./Client";
import * as RivetError from "./RivetError";
import { hasStringProperty } from "./utils";

const TypeId = "~@rivetkit/effect/Actor";

export const isActor = (u: unknown): u is Actor<any, any> =>
	Predicate.hasProperty(u, TypeId);

export type GlobalActorOptionsInput = Pick<
	NonNullable<Rivetkit.GlobalActorOptionsInput>,
	"name" | "icon"
>;

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

/**
 * Connection options for the Rivet Engine. Mirrors the
 * `(endpoint, token, namespace)` subset of rivetkit's
 * `RegistryConfigInput`. All fields are optional and fall back to the
 * matching `RIVET_*` environment variables (see the canonical schema
 * for the exact resolution order).
 */
export type RegistryOptions = Pick<
	Rivetkit.RegistryConfigInput<Rivetkit.RegistryActors>,
	"endpoint" | "token" | "namespace"
>;

/**
 * Service collecting actor defs/builders together with the engine
 * connection config. Provided once via `Registry.layer({ ... })` and
 * consumed by both `Actor.toLayer` (which registers itself into the
 * collector on acquire) and the `Runner.*` mode layers (which
 * materialize the underlying rivetkit registry from the collected
 * entries).
 */
export class Registry extends Context.Service<Registry, {
	readonly options: RegistryOptions;
	readonly register: (entry: RegistryEntry) => Effect.Effect<void>;
	readonly entries: Effect.Effect<ReadonlyArray<RegistryEntry>>;
}>()(
	"@rivetkit/effect/Actor/Registry",
) {
	static layer(options: RegistryOptions = {}) {
		return Layer.effect(
			Registry,
			Effect.gen(function* () {
				const ref = yield* Ref.make<ReadonlyArray<RegistryEntry>>([]);
				return Registry.of({
					options,
					register: (entry) =>
						Ref.update(ref, (xs) => [...xs, entry]),
					entries: Ref.get(ref),
				});
			}),
		);
	}
}

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

const toRivetkitActor = Effect.fnUntraced(function* (
	entry: RegistryEntry,
	instances: Map<string, ActorInstance>,
) {
	// Snapshot the current Effect context so action callbacks
	// (which run in rivetkit's plain Promise world) can run
	// handler effects against the same services the Runner layer
	// was provided with.
	const services = yield* Effect.context<any>();
	const actor = entry.actor;

	const actions: Record<
		string,
		(
			c: Pick<ActorAddress, "actorId">,
			payload?: unknown,
		) => Promise<unknown>
	> = {};
	for (const action of actor.actions) {
		const decodePayload = Schema.decodeUnknownEffect(action.payloadSchema);
		const encodeSuccess = Schema.encodeUnknownEffect(action.successSchema);
		const encodeError = Schema.encodeUnknownEffect(action.errorSchema);
		actions[action._tag] = async (c, payload) => {
			const inst = instances.get(c.actorId);
			if (!inst) {
				throw new Error(
					`actor ${actor._tag}/${c.actorId} has no handlers (onWake didn't run?)`,
				);
			}
			const handler = inst.handlers[action._tag];
			if (!handler) {
				throw new Error(
					`actor ${actor._tag} has no handler for action ${action._tag}`,
				);
			}

			const pipeline = Effect.gen(function* () {
				const decoded = yield* decodePayload(payload).pipe(
					Effect.orDie,
				);
				const result = yield* handler({
					_tag: action._tag,
					action,
					payload: decoded,
				}).pipe(
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
										code: hasStringProperty("_tag")(error)
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
			});

			const exit = await Effect.runPromiseExitWith(services)(pipeline);
			if (Exit.isSuccess(exit)) return exit.value;
			throw Cause.squash(exit.cause);
		};
	}

	return Rivetkit.actor({
		actions,
		options: actor.options,
		onWake: async (
			c: Rivetkit.WakeContextOf<Rivetkit.AnyActorDefinition>,
		) => {
			const address: ActorAddress = {
				actorId: c.actorId,
				name: c.name,
				key: c.key,
			};
			// Single fused effect: build the wake scope, then run
			// `buildHandlers` in that scope with `CurrentAddress`
			// provided. Keeping both pieces in one fiber means a
			// `buildHandlers` failure shares its cause with the scope it
			// would have owned.
			const acquire = Effect.gen(function* () {
				const scope = yield* Scope.make();
				const built = entry.buildHandlers as Effect.Effect<
					unknown,
					never,
					Scope.Scope | CurrentAddress
				>;
				const handlers = yield* built.pipe(
					Effect.provideService(CurrentAddress, address),
					Effect.provideService(Scope.Scope, scope),
				) as Effect.Effect<unknown, never, never>;
				return { handlers, scope };
			});
			const { handlers, scope } =
				await Effect.runPromiseWith(services)(acquire);
			instances.set(c.actorId, {
				handlers: handlers as ActorInstance["handlers"],
				scope,
			});
		},
		onSleep: async (
			c: Rivetkit.SleepContextOf<Rivetkit.AnyActorDefinition>,
		) => {
			const inst = instances.get(c.actorId);
			if (!inst) return;
			instances.delete(c.actorId);
			await Effect.runPromiseWith(services)(
				Scope.close(inst.scope, Exit.void),
			);
		},
	});
});

/**
 * Build the underlying rivetkit registry from the collected `Registry`
 * entries. The returned registry is configured but not started; callers
 * apply mode-specific config (test flags, engine spawn) and then invoke
 * `.start()` themselves.
 */
const toRivetkitRegistry = Effect.fnUntraced(function* (
	registry: Registry["Service"],
) {
	const entries = yield* registry.entries;
	const instances = new Map<string, ActorInstance>();
	const use: Record<string, Rivetkit.AnyActorDefinition> = {};
	for (const entry of entries) {
		use[entry.actor._tag] = yield* toRivetkitActor(entry, instances);
	}

	return Rivetkit.setup({
		use,
		...registry.options,
	});
});

/**
 * Service that selects how the registered actors are served. Each
 * static field is a `Layer` for a specific mode mirroring the
 * non-Effect TS SDK: `start`. Each requires `Registry`.
 */
export class Runner extends Context.Service<Runner, {
	readonly mode: "start" | "test";
}>()(
	"@rivetkit/effect/Actor/Runner",
) {
	static start = Layer.effect(
		Runner,
		Effect.gen(function* () {
			const registry = yield* Registry;
			const rivetkitRegistry = yield* toRivetkitRegistry(registry);
			yield* Effect.sync(() => rivetkitRegistry.start());
			return Runner.of({ mode: "start" });
		}),
	);

	/**
	 * In-process test runtime. Boots the rivetkit registry against the
	 * configured engine, waits for `/health` to answer, and provides
	 * both `Runner` and `Client` from one Layer so consumers don't need
	 * to wire `Client.layer` separately. Mirrors `Runner.start` plus
	 * test-mode flags and a scoped client dispose. The registry itself
	 * is leaked to process exit because the public rivetkit `Registry`
	 * doesn't expose a public `shutdown()` today; only the SIGINT
	 * handler can drive `#runShutdown`. This matches `setupTest`'s
	 * existing behavior.
	 */
	static test: Layer.Layer<Runner | Client, never, Registry> =
		Layer.effectContext(
			Effect.gen(function* () {
				const registry = yield* Registry;
				const rivetkitRegistry = yield* toRivetkitRegistry(registry);
				rivetkitRegistry.config.test = {
					...rivetkitRegistry.config.test,
					enabled: true,
				};
				rivetkitRegistry.config.noWelcome = true;
				// Auto-spawn the engine when no endpoint was provided, so
				// `Runner.test` works out of the box without requiring the
				// caller to start an engine externally. If the user wired an
				// explicit endpoint via `Registry.layer({ endpoint: ... })`,
				// honor it and skip the local spawn.
				if (registry.options.endpoint === undefined) {
					rivetkitRegistry.config.startEngine = true;
				}
				yield* Effect.sync(() => rivetkitRegistry.start());

				// The rivetkitRegistry itself is leaked until process exit (matches
				// setupTest's behavior). The public Rivetkit.Registry doesn't
				// expose a shutdown method; only the SIGINT handler can drive the
				// inner .shutdown(). Disposing the client is the only cleanup we
				// can do cleanly today.
				//
				// When the engine was auto-spawned, propagate its resolved
				// endpoint to the client so `createClient` doesn't fall back
				// to its (warning-emitting) default.
				const resolvedEndpoint =
					rivetkitRegistry.parseConfig().endpoint;
				const rivetkitClient = yield* Effect.acquireRelease(
					Effect.sync(() =>
						RivetkitClient.createClient({
							...registry.options,
							endpoint:
								registry.options.endpoint ?? resolvedEndpoint,
						}),
					),
					(c) => Effect.promise(() => c.dispose()),
				);

				const callAction: ClientService["callAction"] = ({
					actorName,
					key,
					actionName,
					encodedPayload,
				}) =>
					Effect.tryPromise({
						try: () =>
							rivetkitClient[actorName].getOrCreate(key).action({
								name: actionName,
								args: [encodedPayload],
							}),
						catch: (cause) =>
							cause instanceof Rivetkit.RivetError
								? cause
								: new Rivetkit.RivetError(
										"client",
										"unknown",
										cause instanceof Error
											? cause.message
											: String(cause),
										{
											cause:
												cause instanceof Error
													? cause
													: undefined,
										},
									),
					});

				return Context.make(Runner, Runner.of({ mode: "test" })).pipe(
					Context.add(Client, Client.of({ callAction })),
				);
			}),
		);
}

export type ActionRequest<A extends Action.AnyWithProps> =
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

export type ActorKeyParam = string | Rivetkit.ActorKey;

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
		Action.Error<A> | RivetError.RivetError
	>;
};

/**
 * Yielded by `Actor.client`. Address an actor instance by key, then
 * dispatch typed action calls against the returned `Handle`.
 */
export interface TypedAccessor<Actions extends Action.AnyWithProps> {
	readonly getOrCreate: (key: ActorKeyParam) => Handle<Actions>;
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
	readonly options: GlobalActorOptionsInput;

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

export type Actions<A> =
	A extends Actor<any, infer _Actions> ? _Actions : never;

export type Services<A> =
	A extends Actor<any, infer _Actions> ? Action.Services<_Actions> : never;

export type ClientServices<A> =
	A extends Actor<any, infer _Actions>
		? Action.ServicesClient<_Actions>
		: never;

export type ServerServices<A> =
	A extends Actor<any, infer _Actions>
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
				getOrCreate: (key: ActorKeyParam) => {
					const handle: Record<
						string,
						(p: unknown) => Effect.Effect<unknown, unknown>
					> = {};
					for (const action of actions) {
						const tag = action._tag;
						handle[tag] = (payload) =>
							Effect.gen(function* () {
								const encoded =
									yield* Schema.encodeUnknownEffect(
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
												(
													rivetErr as {
														metadata?: unknown;
													}
												).metadata,
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
	readonly options: GlobalActorOptionsInput;
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
		readonly options?: GlobalActorOptionsInput;
	},
): Actor<Name, Actions[number]> => {
	return makeProto({
		_tag: name,
		actions: (options?.actions ?? []) as ReadonlyArray<Action.AnyWithProps>,
		options: options?.options ?? {},
	}) as any;
};
