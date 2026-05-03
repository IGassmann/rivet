import { assert, describe, layer } from "@effect/vitest";
import { Effect, Layer, Ref, Schema } from "effect";
import { Action, Actor, Registry, Runner } from "@rivetkit/effect";

class CounterOverflowError extends Schema.TaggedErrorClass<CounterOverflowError>()(
	"CounterOverflowError",
	{
		limit: Schema.Number,
		message: Schema.String,
	},
) {}

const Increment = Action.make("Increment", {
	payload: { amount: Schema.Number },
	success: Schema.Number,
	error: CounterOverflowError,
});

const GetCount = Action.make("GetCount", {
	success: Schema.Number,
});

const Counter = Actor.make("Counter", {
	actions: [Increment, GetCount],
});

const CounterLive = Counter.toLayer(
	Effect.gen(function* () {
		const count = yield* Ref.make(0);
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
		});
	}),
);

const TestLayer = Runner.test.pipe(
	Layer.provideMerge(CounterLive),
	Layer.provide(Registry.layer()),
);

describe("Runner.test", () => {
	layer(TestLayer, { timeout: "15 seconds" })("Counter end-to-end", (it) => {
		it.effect("invokes an action and returns the typed success value", () =>
			Effect.gen(function* () {
				const counter = (yield* Counter.client).getOrCreate([
					"t-success",
				]);
				const next = yield* counter.Increment({ amount: 5 });
				assert.strictEqual(next, 5);
			}),
		);

		it.effect("preserves in-wake state across calls on the same key", () =>
			Effect.gen(function* () {
				const counter = (yield* Counter.client).getOrCreate([
					"t-state",
				]);
				yield* counter.Increment({ amount: 3 });
				yield* counter.Increment({ amount: 4 });
				const total = yield* counter.GetCount();
				assert.strictEqual(total, 7);
			}),
		);

		it.effect(
			"decodes typed errors back into the original tagged class",
			() =>
				Effect.gen(function* () {
					const counter = (yield* Counter.client).getOrCreate([
						"t-overflow",
					]);
					const exit = yield* counter
						.Increment({ amount: 100 })
						.pipe(Effect.exit);
					assert.isTrue(exit._tag === "Failure");
					yield* counter.Increment({ amount: 100 }).pipe(
						Effect.catchTag("CounterOverflowError", (e) =>
							Effect.sync(() => {
								assert.strictEqual(e.limit, 20);
								assert.match(e.message, /exceed limit 20/);
							}),
						),
					);
				}),
		);
	});
});
