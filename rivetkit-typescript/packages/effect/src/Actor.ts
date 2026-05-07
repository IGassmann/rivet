import {
	Cause,
	Context,
	Effect,
	Exit,
	identity,
	Layer,
	Predicate,
	Ref,
	Schema,
	Scope,
	Stream,
	SubscriptionRef,
	Tracer,
} from "effect";
import * as Rivetkit from "rivetkit";
import * as RivetkitClient from "rivetkit/client";
import type * as Action from "./Action";
import type * as ActorState from "./ActorState";
import { Client, type ActionMeta, type ClientService } from "./Client";
import { readTraceMeta, rpcSystem } from "./internal/tracing";
import * as RivetError from "./RivetError";
import { hasStringProperty } from "./utils";

const TypeId = "~@rivetkit/effect/Actor";

export const isActor = (u: unknown): u is Actor<any, any> =>
	Predicate.hasProperty(u, TypeId);

export type RivetkitActorOptions = Pick<
	NonNullable<Rivetkit.GlobalActorOptionsInput>,
	"name" | "icon"
>;

/**
 * Per-actor instance options. Combines the public
 * `RivetkitActorOptions` (forwarded verbatim to `Rivetkit.actor`)
 * with the effect-SDK-only options.
 */
export type ActorOptions<State extends ActorState.AnyWithProps> =
	Readonly<RivetkitActorOptions> & {
		readonly state?: State;
	};

const splitActorOptions = <State extends ActorState.AnyWithProps>(
	options: ActorOptions<State>,
): {
	readonly rivetkitOptions: RivetkitActorOptions;
	readonly effectOptions: Omit<
		ActorOptions<State>,
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

/**
 * One actor registered with the `Registry`. The `buildHandlers`
 * effect is run once per wake by the runner to construct
 * per-instance state and handlers; the handlers themselves are not
 * resolved at registration time.
 *
 * `state`, when present, carries the persisted-state schema and
 * initial-value factory. The runner uses it to seed `c.state` on
 * first create and to provide a typed `SubscriptionRef` under the
 * state's tag inside the build effect's context.
 */
interface RegistryEntry<
	Name extends string,
	Actions extends Action.Any,
	Handlers extends HandlersFrom<Actions>,
	RX,
	State extends ActorState.AnyWithProps = never,
> {
	readonly actor: Actor<Name, Actions>;
	readonly buildHandlers: Effect.Effect<Handlers, never, RX>;
	readonly options?: ActorOptions<State>;
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
export class Registry extends Context.Service<
	Registry,
	{
		readonly options: RegistryOptions;
		readonly register: <
			Name extends string,
			Actions extends Action.Any,
			Handlers extends HandlersFrom<Actions>,
			RX,
			State extends ActorState.AnyWithProps = never,
		>(
			entry: RegistryEntry<Name, Actions, Handlers, RX, State>,
		) => Effect.Effect<void>;
		readonly entries: Effect.Effect<
			ReadonlyArray<RegistryEntry<any, any, any, any, any>>
		>;
	}
>()("@rivetkit/effect/Actor/Registry") {
	static layer(options: RegistryOptions = {}) {
		return Layer.effect(
			Registry,
			Effect.gen(function* () {
				const ref = yield* Ref.make<
					ReadonlyArray<RegistryEntry<any, any, any, any, any>>
				>([]);
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
	entry: RegistryEntry<any, any, any, any, any>,
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
			meta?: unknown,
		) => Promise<unknown>
	> = {};
	for (const action of actor.actions) {
		const decodePayload = Schema.decodeUnknownEffect(action.payloadSchema);
		const encodeSuccess = Schema.encodeUnknownEffect(action.successSchema);
		const encodeError = Schema.encodeUnknownEffect(action.errorSchema);
		actions[action._tag] = async (c, payload, meta) => {
			const inst = instances.get(c.actorId);
			if (!inst) {
				throw new Error(
					`actor ${actor.name}/${c.actorId} has no handlers (onWake didn't run?)`,
				);
			}
			const handler = inst.handlers[action._tag];
			if (!handler) {
				throw new Error(
					`actor ${actor.name} has no handler for action ${action._tag}`,
				);
			}

			let pipeline: Effect.Effect<unknown, never, unknown> = Effect.gen(
				function* () {
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
				},
			);

			// Always wrap in a server-side span so the handler has a
			// live `currentSpan` even when the caller didn't ship trace
			// context (e.g. a non-Effect-SDK client). When trace context
			// is present, reattach it as the parent so the server span
			// joins the caller's trace.
			const rpcMethod = `${actor.name}/${action._tag}`;
			const traceMeta = readTraceMeta(meta);
			pipeline = pipeline.pipe(
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
			);

			const exit = await Effect.runPromiseExitWith(services)(pipeline);
			if (Exit.isSuccess(exit)) return exit.value;
			throw Cause.squash(exit.cause);
		};
	}

	const actorOptions = entry.options
		? splitActorOptions(entry.options)
		: undefined;
	const stateDef = actorOptions?.effectOptions.state;
	const hasState = actorOptions?.effectOptions.state !== undefined;

	return Rivetkit.actor({
		actions,
		options: actorOptions?.rivetkitOptions,
		// rivetkit invokes this once at create time and seeds c.state
		// with the result. We delegate to the user-supplied `initial`
		// factory so primitive states (e.g. `Schema.Number`) don't need
		// `Schema.withConstructorDefault` boilerplate.
		...(hasState
			? {
					createState: () => stateDef.initial(),
				}
			: {}),
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

				const stateRef = yield* SubscriptionRef.make<unknown>(
					hasState ? c.state : undefined,
				);
				if (hasState) {
					// Mirror published changes back to c.state so
					// rivetkit's throttled save loop and shutdown flush
					// pick them up. The identity guard skips no-op
					// updates; otherwise rivetkit re-encodes the value
					// as CBOR and reschedules a save on every publish.
					yield* SubscriptionRef.changes(stateRef).pipe(
						Stream.drop(1),
						Stream.runForEach((value) =>
							Effect.sync(() => {
								if (value !== c.state) c.state = value;
							}),
						),
						Effect.forkIn(scope),
					);
				}

				const built = entry.buildHandlers;
				let provided = built.pipe(
					Effect.provideService(CurrentAddress, address),
					Effect.provideService(Scope.Scope, scope),
					Effect.provideService(
						Sleep,
						Effect.sync(() => c.sleep()),
					),
				);
				if (hasState) {
					// Provide the SubscriptionRef under the user's typed
					// `ActorState` tag so `yield* MyState` inside the build
					// effect resolves to a `SubscriptionRef<S["Type"]>`.
					provided = Effect.provideService(
						provided,
						stateDef,
						stateRef,
					);
				}
				return { handlers: yield* provided, scope };
			});
			const { handlers, scope } =
				await Effect.runPromiseWith(services)(acquire);
			instances.set(c.actorId, {
				handlers,
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
		use[entry.actor.name] = yield* toRivetkitActor(entry, instances);
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
export class Runner extends Context.Service<
	Runner,
	{
		readonly mode: "start" | "test";
	}
>()("@rivetkit/effect/Actor/Runner") {
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
					meta,
				}) =>
					Effect.tryPromise({
						try: () =>
							rivetkitClient[actorName].getOrCreate(key).action({
								name: actionName,
								args: meta
									? [encodedPayload, meta]
									: [encodedPayload],
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
		options?: ActorOptions<State>,
	): Layer.Layer<
		never,
		never,
		| Exclude<RX, Scope.Scope | CurrentAddress | Sleep | State>
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

export type Any = Actor<string, Action.AnyWithProps>;

export type HandlersFrom<Action extends Action.Any> = {
	readonly [Current in Action as Current["_tag"]]: (
		envelope: ActionRequest<Current>,
	) => Action.ResultFrom<Current, any>;
};

const Proto = {
	[TypeId]: TypeId,
	toLayer<
		Actions extends Action.Any,
		Handlers extends HandlersFrom<Actions>,
		State extends ActorState.AnyWithProps = never,
		RX = never,
	>(
		this: Actor<string, Actions>,
		build: Handlers | Effect.Effect<Handlers, never, RX>,
		options?: ActorOptions<State>,
	) {
		const self = this;
		return Layer.effectDiscard(
			Effect.gen(function* () {
				const registry = yield* Registry;
				yield* registry.register({
					actor: self,
					buildHandlers: Effect.isEffect(build)
						? build
						: Effect.succeed(build),
					options,
				});
			}),
		);
	},
	get client() {
		const self = this as Any;
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
							const meta: ActionMeta = {
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
