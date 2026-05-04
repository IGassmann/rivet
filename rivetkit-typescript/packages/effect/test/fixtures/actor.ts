import { Context, Effect, Ref, Schema, SchemaTransformation } from "effect";
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

export const Counter = Actor.make("Counter", {
	actions: [
		Increment,
		GetCount,
		Crash,
		EchoDate,
		Tags,
		Greet,
		WakeGreeting,
		Scale,
	],
});

export const CounterLive = Counter.toLayer(
	Effect.gen(function* () {
		const count = yield* Ref.make(0);
		// Wake-scope yield of a non-built-in service. Resolved once per
		// wake; the captured value is closed over by `WakeGreeting`.
		const greeter = yield* Greeter;
		const wakeGreeting = greeter.greet("on wake");
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
