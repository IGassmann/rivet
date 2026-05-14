import { Context, Effect, Layer } from "effect";
import * as Rivetkit from "rivetkit";
import * as RivetkitClient from "rivetkit/client";
import { Client, type ClientService } from "./Client";

const TypeId = "~@rivetkit/effect/Registry";

export type Options = Pick<
	Rivetkit.RegistryConfigInput<Rivetkit.RegistryActors>,
	"endpoint" | "token" | "namespace" | "envoy"
>;

export interface Registry {
	readonly [TypeId]: typeof TypeId;

	readonly options: Options;

	readonly rivetkitActors: Map<string, Rivetkit.AnyActorDefinition>;
}

export const Registry: Context.Service<Registry, Registry> =
	Context.Service<Registry>("@rivetkit/effect/Registry");

export const make = (options: Options = {}): Registry => {
	return Registry.of({
		[TypeId]: TypeId,
		options,
		rivetkitActors: new Map(),
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
		const rivetkitRegistry = Rivetkit.setup({
			use: Object.fromEntries(registry.rivetkitActors),
			...registry.options,
		});
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
		const rivetkitRegistry = Rivetkit.setup({
			use: Object.fromEntries(registry.rivetkitActors),
			...registry.options,
		});
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
					// `RegistryConfigInput` nests pool under `envoy.poolName`
					// but the client schema reads `poolName` at the top
					// level, so propagate it explicitly.
					poolName: registry.options.envoy?.poolName,
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
