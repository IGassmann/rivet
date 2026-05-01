import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import type * as Action from "./Action";

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
	readonly _: unique symbol;
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
	mode: string,
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

/**
 * Service that selects how the registered actors are served. Each
 * static field is a `Layer` for a specific mode mirroring the
 * non-Effect TS SDK: `start`, `serve`, `handler`, `startEnvoy`, plus a
 * `test` mode for in-process testing. Each requires `Registry`.
 */
export class Runner extends Context.Service<Runner, RunnerShape>()(
	"@rivetkit/effect/Actor/Runner",
) {
	static start: Layer.Layer<Runner, never, Registry> =
		runnerNotImplemented("start");
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
		| Exclude<RX, Scope.Scope>
		| HandlerServices<Handlers>
		| Action.ServicesServer<Actions>
		| Action.ServicesClient<Actions>
		| Registry
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
