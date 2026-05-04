import {
	Context,
	Effect,
	Ref,
	Schema,
	SchemaTransformation,
	SubscriptionRef,
} from "effect";
import { Action, Actor } from "@rivetkit/effect";

// --- Counter ---

export class CounterOverflowError extends Schema.TaggedErrorClass<CounterOverflowError>()(
	"CounterOverflowError",
	{
		limit: Schema.Number,
		message: Schema.String,
	},
) {}

/**
 * A non-built-in service used by `Counter` to verify that user-provided
 * services resolve in both the wake-scope build effect and inside
 * individual action handlers.
 */
export class Greeter extends Context.Service<
	Greeter,
	{ readonly greet: (name: string) => string }
>()("test/Greeter") {}

const TagsCsv = Schema.String.pipe(
	Schema.decodeTo(
		Schema.Array(Schema.String),
		SchemaTransformation.transform({
			decode: (s: string): ReadonlyArray<string> => s.split(","),
			encode: (arr: ReadonlyArray<string>) => arr.join(","),
		}),
	),
);

export const Increment = Action.make("Increment", {
	payload: { amount: Schema.Number },
	success: Schema.Number,
	error: CounterOverflowError,
});

export const GetCount = Action.make("GetCount", {
	success: Schema.Number,
});

export const Crash = Action.make("Crash");

export const EchoDate = Action.make("EchoDate", {
	payload: { when: Schema.DateFromString },
	success: Schema.DateFromString,
});

export const Tags = Action.make("Tags", {
	payload: { tags: TagsCsv },
	success: Schema.Number,
});

export const Greet = Action.make("Greet", {
	payload: { name: Schema.String },
	success: Schema.String,
});

export const WakeGreeting = Action.make("WakeGreeting", {
	success: Schema.String,
});

// An action whose handler emits its own user-defined sub-span. The
// tracing test asserts the sub-span lands as a child of the SDK's
// server-side span, which itself is a child of the SDK's client-side
// span — proof that user spans nest correctly under the SDK's wire
// propagation.
export const Compute = Action.make("Compute", {
	payload: { n: Schema.Number },
	success: Schema.Number,
});

// Service that the codec schema below depends on. Yielding it from
// inside a `transformOrFail` puts `Multiplier` into the schema's
// `DecodingServices` / `EncodingServices`, which in turn surfaces in
// `Action.ServicesServer` / `Action.ServicesClient` for any action
// referencing the codec.
export class Multiplier extends Context.Service<
	Multiplier,
	{ readonly factor: number }
>()("test/Multiplier") {}

// A `Number` schema whose decode multiplies by the live factor and whose
// encode divides by it. With the same factor on both ends, values
// round-trip; the test would fail if any codec site failed to resolve
// `Multiplier`.
const ScaledNumber = Schema.Number.pipe(
	Schema.decodeTo(
		Schema.Number,
		SchemaTransformation.transformOrFail({
			decode: (n: number) =>
				Effect.gen(function* () {
					const m = yield* Multiplier;
					return n * m.factor;
				}),
			encode: (n: number) =>
				Effect.gen(function* () {
					const m = yield* Multiplier;
					return n / m.factor;
				}),
		}),
	),
);

export class ScaledOverflowError extends Schema.TaggedErrorClass<ScaledOverflowError>()(
	"ScaledOverflowError",
	{
		limit: ScaledNumber,
		message: Schema.String,
	},
) {}

// Every channel of this action — payload, success, error — references
// `ScaledNumber`, so a successful round-trip proves all six codec sites
// (payload encode + decode, success encode + decode, error encode +
// decode) resolved their schema services.
export const Scale = Action.make("Scale", {
	payload: { amount: ScaledNumber },
	success: ScaledNumber,
	error: ScaledOverflowError,
});

export const PersistedTotal = Action.make("PersistedTotal", {
	payload: { amount: Schema.Number },
	success: Schema.Number,
});

export const PersistAndSleep = Action.make("PersistAndSleep", {
	payload: { amount: Schema.Number },
	success: Schema.Number,
});

export const Counter = Actor.make("Counter", {
	state: Schema.Struct({
		count: Schema.Number.pipe(
			Schema.withConstructorDefault(Effect.succeed(0)),
		),
	}),
	actions: [
		Increment,
		GetCount,
		Crash,
		EchoDate,
		Tags,
		Greet,
		WakeGreeting,
		Compute,
		Scale,
		PersistedTotal,
		PersistAndSleep,
	],
});

export const CounterLive = Counter.toLayer(
	Effect.gen(function* () {
		const state = yield* Counter.State;
		const count = yield* Ref.make(0);
		// Wake-scope yield of a non-built-in service. Resolved once per
		// wake; the captured value is closed over by `WakeGreeting`.
		const greeter = yield* Greeter;
		const wakeGreeting = greeter.greet("on wake");

		const sleep = yield* Actor.Sleep;

		return Counter.of({
			Increment: ({ payload }) =>
				Effect.gen(function* () {
					const next = yield* Ref.updateAndGet(
						count,
						(n) => n + payload.amount,
					);
					if (next > 20) {
						return yield* new CounterOverflowError({
							limit: 20,
							message: `count ${next} would exceed limit 20`,
						});
					}
					return next;
				}),
			GetCount: () => Ref.get(count),
			Crash: () => Effect.die("kaboom"),
			EchoDate: ({ payload }) => Effect.succeed(payload.when),
			Tags: ({ payload }) => Effect.succeed(payload.tags.length),
			// Per-handler yield of a non-built-in service. Resolved on
			// every call against the snapshotted Runner context.
			Greet: ({ payload }) =>
				Effect.gen(function* () {
					const g = yield* Greeter;
					return g.greet(payload.name);
				}),
			WakeGreeting: () => Effect.succeed(wakeGreeting),
			// User-defined sub-span. The SDK already wraps the handler
			// in a server-side span; the inner `withSpan("step.double")`
			// nests under it, demonstrating that hand-written spans
			// inside a handler join the caller's trace transparently.
			Compute: ({ payload }) =>
				Effect.succeed(payload.n * 2).pipe(
					Effect.withSpan("step.double"),
				),
			Scale: ({ payload }) =>
				Effect.gen(function* () {
					if (payload.amount > 30) {
						return yield* new ScaledOverflowError({
							limit: 30,
							message: `amount ${payload.amount} would exceed limit 30`,
						});
					}
					// +100 makes the round-trip non-tautological: the
					// test asserts on a value the client never sent, so
					// the success path can't pass without the success
					// and payload codec sites firing on both sides.
					return payload.amount + 100;
				}),
			PersistedTotal: ({ payload }) =>
				SubscriptionRef.updateAndGet(state, (s) => ({
					count: s.count + payload.amount,
				})).pipe(Effect.map((s) => s.count)),
			PersistAndSleep: ({ payload }) =>
				Effect.gen(function* () {
					const { count } = yield* SubscriptionRef.updateAndGet(
						state,
						(s) => ({ count: s.count + payload.amount }),
					);
					yield* sleep;
					return count;
				}),
		});
	}),
);

// --- Pinger ---

// Minimal second actor used solely to assert that the registry serves
// more than one actor side-by-side.
export const Ping = Action.make("Ping", { success: Schema.String });

export const Pinger = Actor.make("Pinger", { actions: [Ping] });

export const PingerLive = Pinger.toLayer({
	Ping: () => Effect.succeed("pong"),
});

// --- FailingActor ---

export const FailingActor = Actor.make("FailingBuild", {
	actions: [Ping],
});

export const FailingActorLive = FailingActor.toLayer(
	Effect.die("build effect failed"),
);

// --- Unregistered ---

// Used solely to test the failure shape when calling an actor whose
// `*Live` layer was never provided to the runner. No `UnregisteredLive`
// is exported on purpose — the test relies on this actor being absent
// from the registry at runtime.
export const Echo = Action.make("Echo", { success: Schema.String });

export const Unregistered = Actor.make("Unregistered", { actions: [Echo] });
