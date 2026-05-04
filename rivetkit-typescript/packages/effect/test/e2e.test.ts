import { assert, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { Registry, RivetError, Runner } from "@rivetkit/effect";
import {
	Counter,
	CounterLive,
	CounterOverflowError,
	FailingActor,
	FailingActorLive,
	Greeter,
	Multiplier,
	Pinger,
	PingerLive,
	ScaledOverflowError,
	Unregistered,
} from "./fixtures/actor";

const GreeterLive = Layer.succeed(
	Greeter,
	Greeter.of({
		greet: (name) => `Hello, ${name}!`,
	}),
);

// `Multiplier` has to be in scope on both sides of the wire: the
// `Counter`'s `Scale` action's codec consumes `Action.ServicesServer`
// during registration, and the test body's `Counter.client` getter
// consumes `Action.ServicesClient` for the same action.
// `provideMerge` keeps it as a layer output so the test effect
// itself sees it too.
const MultiplierLive = Layer.succeed(
	Multiplier,
	Multiplier.of({ factor: 2 }),
);

const TestLayer = Runner.test.pipe(
	Layer.provideMerge(
		Layer.mergeAll(CounterLive, PingerLive, FailingActorLive),
	),
	Layer.provide(GreeterLive),
	Layer.provideMerge(MultiplierLive),
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

	it.effect(
		"surfaces a call to an actor with no registered handler as a RivetError",
		() =>
			Effect.gen(function* () {
				// `Unregistered` is defined in the fixtures module but its
				// `*Live` layer is intentionally not provided, so the engine
				// has no runner that can serve the actor. The engine logs
				// the precise `not_registered: Actor factory 'Unregistered'
				// is not registered.` reason but flattens it on the wire to
				// a generic `guard/service_unavailable` — the same code a
				// transient engine outage would surface as. Callers can't
				// distinguish the two without an engine-side change.
				const ghost = (yield* Unregistered.client).getOrCreate([
					"t-unregistered",
				]);
				const exit = yield* ghost.Echo().pipe(Effect.flip, Effect.exit);
				assert.isTrue(exit._tag === "Success");
				if (exit._tag === "Success") {
					assert.instanceOf(exit.value, RivetError.RivetError);
					assert.strictEqual(exit.value.error.group, "guard");
					assert.strictEqual(
						exit.value.error.code,
						"service_unavailable",
					);
				}
			}),
	);

	it.todo("fires the wake-scope finalizer on sleep");

	it.effect("surfaces an error thrown inside an actor's build effect", () =>
		Effect.gen(function* () {
			// `getOrCreate` only builds a typed proxy on the client and
			// rivetkit's wake is lazy on first action, so the build
			// defect surfaces on `.Ping()`, not here.
			const failing = (yield* FailingActor.client).getOrCreate([
				"t-build-error",
			]);
			const exit = yield* failing.Ping().pipe(Effect.flip, Effect.exit);
			assert.isTrue(exit._tag === "Success");
			if (exit._tag === "Success") {
				assert.instanceOf(exit.value, RivetError.RivetError);
			}
		}),
	);

	it.effect(
		"runs encoding/decoding services for an action's payload, success, and error",
		() =>
			Effect.gen(function* () {
				const counter = (yield* Counter.client).getOrCreate([
					"t-codec-services",
				]);

				// Success path. With `factor: 2` provided on both sides:
				// payload encode 10 -> 5 (client divides), payload decode
				// 5 -> 10 (server multiplies), handler returns 110, success
				// encode 110 -> 55 (server divides), success decode 55 -> 110
				// (client multiplies). A wrong final value would mean one
				// of those four codec sites failed to resolve `Multiplier`.
				assert.strictEqual(yield* counter.Scale({ amount: 10 }), 110);

				// Error path. The handler short-circuits with a
				// `ScaledOverflowError({ limit: 30 })`. The error's `limit`
				// flows through the same service-dependent schema: server
				// encode 30 -> 15, client decode 15 -> 30. A factor mismatch
				// or an unprovided service on either side would surface as
				// a numeric mismatch on `exit.value.limit`.
				const exit = yield* counter
					.Scale({ amount: 40 })
					.pipe(Effect.flip, Effect.exit);
				assert.isTrue(exit._tag === "Success");
				if (exit._tag === "Success") {
					assert.instanceOf(exit.value, ScaledOverflowError);
					assert.strictEqual(exit.value.limit, 30);
					assert.match(exit.value.message, /exceed limit 30/);
				}
			}),
	);

	it.todo("propagates Effect tracing spans end-to-end");
});
