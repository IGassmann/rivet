import { Effect, Ref, Schema } from "effect";
import { Action, Actor } from "@rivetkit/effect";

export class CounterOverflowError extends Schema.TaggedErrorClass<CounterOverflowError>()(
	"CounterOverflowError",
	{
		limit: Schema.Number,
		message: Schema.String,
	},
) {}

export const Increment = Action.make("Increment", {
	payload: { amount: Schema.Number },
	success: Schema.Number,
	error: CounterOverflowError,
});

export const GetCount = Action.make("GetCount", {
	success: Schema.Number,
});

export const Counter = Actor.make("Counter", {
	actions: [Increment, GetCount],
});

export const CounterLive = Counter.toLayer(
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
