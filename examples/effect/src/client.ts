// Effect-flavored client driving the same server as `pnpm start`.
// Run alongside the server:
//
//   # terminal A — start the server (auto-spawns local engine)
//   RIVET_RUN_ENGINE=1 \
//   RIVET_ENGINE_BINARY=$(git rev-parse --show-toplevel)/target/debug/rivet-engine \
//   pnpm start
//
//   # terminal B — drive the Effect client
//   pnpm client
//
// For raw-transport diagnostics (no Effect), see `client-raw.ts`
// (`pnpm client:raw`).
import { Effect } from "effect"
import { Client } from "@rivetkit/effect"
import { Counter } from "./actors/counter/api.ts"

const program = Effect.gen(function* () {
	const counterClient = yield* Counter.client
	const counter = counterClient.getOrCreate(["counter-effect"])

	const count = yield* counter.Increment({ amount: 5 })
	yield* Effect.log(`Increment(5) -> ${count}`)

	const total = yield* counter.GetCount()
	yield* Effect.log(`GetCount -> ${total}`)

	// Trigger overflow (limit: 20). The typed CounterOverflowError
	// round-trips through a UserError on the wire and decodes back
	// into the original error class — caught by the outer
	// `catchTag("CounterOverflowError", ...)`.
	const overflowed = yield* counter.Increment({ amount: 100 })
	yield* Effect.log(`Increment(100) [unexpected success]: ${overflowed}`)
}).pipe(
	Effect.catchTag("CounterOverflowError", (e) =>
		Effect.log(
			`CounterOverflowError caught: limit=${e.limit} message="${e.message}"`,
		),
	),
)

const ClientLayer = Client.layer({ endpoint: "http://127.0.0.1:6420" })

program.pipe(Effect.provide(ClientLayer), Effect.runPromise).catch((err) => {
	console.error("client failed:", err)
	process.exit(1)
})
