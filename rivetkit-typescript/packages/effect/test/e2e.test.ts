import { assert, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { Registry, RivetError, Runner } from "@rivetkit/effect";
import {
	Counter,
	CounterLive,
	CounterOverflowError,
	Greeter,
	Pinger,
	PingerLive,
} from "./fixtures/actor";

const GreeterLive = Layer.succeed(
	Greeter,
	Greeter.of({
		greet: (name) => `Hello, ${name}!`,
	}),
);

const TestLayer = Runner.test.pipe(
	Layer.provideMerge(Layer.mergeAll(CounterLive, PingerLive)),
	Layer.provide(GreeterLive),
	Layer.provide(Registry.layer()),
);

layer(TestLayer)("end-to-end", (it) => {
	it.effect("round-trips an action with payload and success", () =>
		Effect.gen(function* () {
			const counter = (yield* Counter.client).getOrCreate("t-roundtrip");
			assert.strictEqual(yield* counter.Increment({ amount: 5 }), 5);
		}),
	);

	it.effect("preserves in-wake state across calls on the same key", () =>
		Effect.gen(function* () {
			const counter = (yield* Counter.client).getOrCreate(["t-state"]);
			yield* counter.Increment({ amount: 3 });
			yield* counter.Increment({ amount: 4 });
			const total = yield* counter.GetCount();
			assert.strictEqual(total, 7);
		}),
	);

	it.effect("isolates in-wake state across keys", () =>
		Effect.gen(function* () {
			const client = yield* Counter.client;
			const a = client.getOrCreate(["t-iso-a"]);
			const b = client.getOrCreate(["t-iso-b"]);
			yield* a.Increment({ amount: 2 });
			yield* a.Increment({ amount: 3 });
			yield* b.Increment({ amount: 1 });
			assert.strictEqual(yield* a.GetCount(), 5);
			assert.strictEqual(yield* b.GetCount(), 1);
		}),
	);

	it.effect("surfaces an expected handler error back into the original error", () =>
		Effect.gen(function* () {
			const counter = (yield* Counter.client).getOrCreate(["t-expected-error"]);
			const exit = yield* counter.Increment({ amount: 100 }).pipe(
				Effect.flip,
				Effect.exit,
			);
			assert.isTrue(exit._tag === "Success");
			if (exit._tag === "Success") {
				assert.instanceOf(exit.value, CounterOverflowError);
				assert.strictEqual(exit.value.limit, 20);
				assert.match(exit.value.message, /exceed limit 20/);
			}
		}),
	);

	it.effect("surfaces an unexpected handler error as a RivetError", () =>
		Effect.gen(function* () {
			const counter = (yield* Counter.client).getOrCreate(["t-boom"]);
			const exit = yield* counter.Crash().pipe(Effect.flip, Effect.exit);
			assert.isTrue(exit._tag === "Success");
			if (exit._tag === "Success") {
				assert.instanceOf(exit.value, RivetError.RivetError);
			}
		}),
	);

	it.effect("round-trips a non-trivial schema (Date)", () =>
		Effect.gen(function* () {
			const counter = (yield* Counter.client).getOrCreate(["t-date"]);
			const when = new Date("2024-01-15T10:30:00.000Z");
			const result = yield* counter.EchoDate({ when });
			assert.instanceOf(result, Date);
			assert.strictEqual(result.toISOString(), when.toISOString());
		}),
	);

	it.effect("round-trips a custom Schema.transform", () =>
		Effect.gen(function* () {
			const counter = (yield* Counter.client).getOrCreate(["t-transform"]);
			// `tags` rides the wire as the encoded CSV string and decodes
			// back to a string array on the server. If the transform
			// didn't fire, `payload.tags.length` would be the byte length
			// of the CSV ("alpha,beta,gamma" = 16) instead of 3.
			const count = yield* counter.Tags({
				tags: ["alpha", "beta", "gamma"],
			});
			assert.strictEqual(count, 3);
		}),
	);

	it.effect("resolves a non-built-in service", () =>
		Effect.gen(function* () {
			const counter = (yield* Counter.client).getOrCreate([
				"t-service-wake",
			]);
			// `WakeGreeting` returns the string captured when `Greeter`
			// was yielded inside the wake-scope build effect.
			const greeting = yield* counter.WakeGreeting();
			assert.strictEqual(greeting, "Hello, on wake!");
		}),
	);

	it.effect(
		"resolves a non-built-in service yielded by an action handler",
		() =>
			Effect.gen(function* () {
				const counter = (yield* Counter.client).getOrCreate([
					"t-service-handler",
				]);
				// `Greet`'s handler yields `Greeter` per call; the
				// snapshotted Runner context must satisfy that R.
				const greeting = yield* counter.Greet({ name: "Effect" });
				assert.strictEqual(greeting, "Hello, Effect!");
			}),
	);

	it.effect("registers and serves multiple actors", () =>
		Effect.gen(function* () {
			const counter = (yield* Counter.client).getOrCreate(["t-multi"]);
			const pinger = (yield* Pinger.client).getOrCreate(["t-multi"]);

			const incremented = yield* counter.Increment({ amount: 7 });
			const pong = yield* pinger.Ping();

			assert.strictEqual(incremented, 7);
			assert.strictEqual(pong, "pong");
		}),
	);

	it.todo("fires the wake-scope finalizer on sleep");
});
