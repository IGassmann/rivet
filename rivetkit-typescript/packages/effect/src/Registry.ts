import {
	Cause,
	Context,
	Effect,
	Exit,
	Layer,
	Option,
	Schema,
	Scope,
	Semaphore,
	Tracer,
} from "effect";
import * as Rivetkit from "rivetkit";
import * as RivetkitClient from "rivetkit/client";
import type * as Action from "./Action";
import * as Actor from "./Actor";
import type * as ActorState from "./ActorState";
import { Client, type ClientService } from "./Client";
import { readTraceMeta, rpcSystem } from "./internal/tracing";
import * as State from "./State";
import { hasStringProperty } from "./utils";

const TypeId = "~@rivetkit/effect/Registry";

/**
 * One actor registered with the `Registry`. The `buildHandlers`
 * effect is run once per wake by the runner to construct
 * per-instance state and handlers; the handlers themselves are not
 * resolved at registration time.
 *
 * `state`, when present, carries the persisted-state schema and
 * initial-value factory. The runner uses it to seed `c.state` on
 * first create and to provide a typed `State` under the state's tag
 * inside the build effect's context.
 */
interface RegistryEntry<
	Name extends string,
	Actions extends Action.Any,
	Handlers extends Actor.HandlersFrom<Actions>,
	RX,
	State extends ActorState.AnyWithProps = never,
> {
	readonly actor: Actor.Actor<Name, Actions>;
	readonly buildHandlers: Effect.Effect<Handlers, never, RX>;
	readonly options?: Actor.Options<State>;
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
	readonly state: Option.Option<State.State<unknown, Schema.SchemaError>>;
};

export interface Registry {
	readonly [TypeId]: typeof TypeId;

	readonly options: Options;

	readonly register: <
		Name extends string,
		Actions extends Action.Any,
		Handlers extends Actor.HandlersFrom<Actions>,
		RX,
		State extends ActorState.AnyWithProps = never,
	>(
		entry: RegistryEntry<Name, Actions, Handlers, RX, State>,
	) => Effect.Effect<void>;

	readonly entries: Effect.Effect<
		ReadonlyArray<RegistryEntry<any, any, any, any, any>>
	>;
}

/**
 * Service collecting actor defs/builders together with the engine
 * connection config. Provided once via `Registry.layer({ ... })` and
 * consumed by both `Actor.toLayer` (which registers itself into the
 * collector on acquire) and by `Registry.start` / `Registry.test`
 * (which materialize the underlying rivetkit registry from the
 * collected entries).
 */
export const Registry: Context.Service<Registry, Registry> =
	Context.Service<Registry>("@rivetkit/effect/Registry");

export type Options = Pick<
	Rivetkit.RegistryConfigInput<Rivetkit.RegistryActors>,
	"endpoint" | "token" | "namespace"
>;

export const make = (options: Options = {}): Registry => {
	const entries: Array<RegistryEntry<any, any, any, any, any>> = [];
	return Registry.of({
		[TypeId]: TypeId,
		options,
		register: (entry) =>
			Effect.sync(() => {
				entries.push(entry);
			}),
		entries: Effect.sync(() => entries),
	});
};

export const layer = (options: Options = {}): Layer.Layer<Registry> =>
	Layer.succeed(Registry, make(options));

/**
 * Run the registered actors against the configured engine. Reads
 * the collected entries, materializes the underlying rivetkit
 * registry, and starts it.
 */
export const serve: Layer.Layer<never, never, Registry> = Layer.effectDiscard(
	Effect.gen(function* () {
		const registry = yield* Registry;
		const rivetkitRegistry = yield* toRivetkitRegistry(registry);
		yield* Effect.sync(() => rivetkitRegistry.start());
	}),
);

/**
 * In-process test runtime. Boots the rivetkit registry against the
 * configured engine, waits for `/health` to answer, and provides
 * `Client` from the same Layer so consumers don't need to wire
 * `Client.layer` separately. Mirrors `Registry.start` plus test-mode
 * flags and a scoped client dispose. The registry itself is leaked
 * to process exit because the public rivetkit `Registry` doesn't
 * expose a public `shutdown()` today; only the SIGINT handler can
 * drive `#runShutdown`. This matches `setupTest`'s existing behavior.
 */
export const test: Layer.Layer<Client, never, Registry> = Layer.effect(
	Client,
	Effect.gen(function* () {
		const registry = yield* Registry;
		const rivetkitRegistry = yield* toRivetkitRegistry(registry);
		rivetkitRegistry.config.test = {
			...rivetkitRegistry.config.test,
			enabled: true,
		};
		rivetkitRegistry.config.noWelcome = true;
		// Auto-spawn the engine when no endpoint was provided, so
		// `Registry.test` works out of the box without requiring the
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
		const resolvedEndpoint = rivetkitRegistry.parseConfig().endpoint;
		const rivetkitClient = yield* Effect.acquireRelease(
			Effect.sync(() =>
				RivetkitClient.createClient({
					...registry.options,
					endpoint: registry.options.endpoint ?? resolvedEndpoint,
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
						args: meta ? [encodedPayload, meta] : [encodedPayload],
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

		return Client.of({ callAction });
	}),
);

/**
 * Build the underlying rivetkit registry from the collected `Registry`
 * entries. The returned registry is configured but not started; callers
 * apply mode-specific config (test flags, engine spawn) and then invoke
 * `.start()` themselves.
 */
const toRivetkitRegistry = Effect.fnUntraced(function* (registry: Registry) {
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

const toRivetkitActor = Effect.fnUntraced(function* (
	{ actor, buildHandlers, options }: RegistryEntry<any, any, any, any, any>,
	instances: Map<string, ActorInstance>,
) {
	// Snapshot the current Effect context so action callbacks
	// (which run in rivetkit's plain Promise world) can run
	// handler effects against the same services the Registry.start /
	// Registry.test layer was provided with.
	const services = yield* Effect.context<any>();

	const actions: Record<
		string,
		(
			c: Pick<Actor.ActorAddress, "actorId">,
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

	const actorOptions = options ? Actor.splitOptions(options) : undefined;
	const stateDef = actorOptions?.effectOptions.state;
	const stateDefOption = Option.fromNullishOr(stateDef);
	const stateInitialValue = Option.isSome(stateDefOption)
		? yield* Schema.encodeUnknownEffect(stateDef.schema)(
				stateDef.initialValue(),
			).pipe(Effect.orDie)
		: undefined;

	return Rivetkit.actor({
		actions,
		options: actorOptions?.rivetkitOptions,
		// rivetkit invokes this once at create time and seeds c.state
		// with the result. We delegate to the user-supplied `initialValue`
		// factory so primitive states (e.g. `Schema.Number`) don't need
		// `Schema.withConstructorDefault` boilerplate.
		...(Option.isSome(stateDefOption)
			? {
					createState: () => stateInitialValue,
				}
			: {}),
		onWake: async (
			c: Rivetkit.WakeContextOf<Rivetkit.AnyActorDefinition>,
		) => {
			const address: Actor.ActorAddress = {
				actorId: c.actorId,
				name: c.name,
				key: c.key,
			};
			// Single fused effect: build the wake scope, then run
			// `buildHandlers` in that scope with `CurrentAddress`
			// provided. Keeping both pieces in one fiber means a
			// `buildHandlers` failure shares its cause with the scope it
			// would have owned.
			const { handlers, scope, state } = await Effect.runPromiseWith(
				services,
			)(
				Effect.gen(function* () {
					const scope = yield* Scope.make();

					const state = Option.isSome(stateDefOption)
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
									() =>
										Schema.decodeUnknownEffect(
											stateDef.schema,
										)(c.state),
									(next) =>
										Schema.encodeUnknownEffect(
											stateDef.schema,
										)(next).pipe(
											Effect.tap((encoded) =>
												Effect.sync(() => {
													c.state = encoded;
												}),
											),
											Effect.asVoid,
										),
								).pipe(Effect.orDie)) as State.State<
									unknown,
									Schema.SchemaError
								>,
							)
						: Option.none();

					const context = Context.mergeAll(
						Context.make(Actor.CurrentAddress, address),
						Context.make(Scope.Scope, scope),
						Context.make(
							Actor.Sleep,
							Effect.sync(() => c.sleep()),
						),
						Option.match(state, {
							onNone: () => Context.empty(),
							onSome: (s) => Context.make(stateDef, s),
						}),
					);

					const handlers = yield* buildHandlers.pipe(
						Effect.provide(context),
					);

					return { handlers, scope, state };
				}),
			);
			instances.set(c.actorId, { handlers, scope, state });
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
		onStateChange: (c, newState) => {
			if (Option.isNone(stateDefOption)) return;
			const inst = instances.get(c.actorId);
			if (!inst || Option.isNone(inst.state)) return;
			const stateRef = inst.state.value;
			// `c.state` already holds `newState` — decode and notify the
			// change stream. The decode is Effect-typed so async schema
			// transforms work; we serialize through the State's semaphore
			// so the publish order matches the write order.
			void Effect.runForkWith(services)(
				Semaphore.withPermit(
					stateRef.semaphore,
					Effect.gen(function* () {
						const decoded = yield* Schema.decodeUnknownEffect(
							stateDef.schema,
						)(newState).pipe(Effect.orDie);
						State.publishUnsafe(stateRef, decoded);
					}),
				),
			);
		},
	});
});
