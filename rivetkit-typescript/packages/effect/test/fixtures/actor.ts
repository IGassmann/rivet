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

export const Counter = Actor.make("Counter", {
	actions: [Increment, GetCount, Crash, EchoDate, Tags, Greet, WakeGreeting],
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
