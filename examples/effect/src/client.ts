// End-to-end smoke test for the Effect SDK server slice.
//
// Drives the actor served by `pnpm start` (main.ts) using a plain
// rivetkit client — the Effect Client surface is out of scope for the
// server-only slice. Run alongside the server:
//
//   # terminal A — start the server (auto-spawns local engine)
//   RIVET_RUN_ENGINE=true \
//   RIVET_ENGINE_BINARY=$(git rev-parse --show-toplevel)/target/debug/rivet-engine \
//   pnpm start
//
//   # terminal B — drive the client
//   pnpm client
import { createClient } from "rivetkit/client"

const client = createClient("http://127.0.0.1:6420") as any

async function main() {
	const counter = client.Counter.getOrCreate("counter-e2e")

	const initial = await counter.GetCount()
	console.log("GetCount (initial):", initial)

	const afterFive = await counter.Increment({ amount: 5 })
	console.log("Increment(5):", afterFive)

	const afterEight = await counter.Increment({ amount: 3 })
	console.log("Increment(3):", afterEight)

	const total = await counter.GetCount()
	console.log("GetCount (total):", total)

	// Trigger overflow (limit: 20). Step 4 surfaces this as a defect
	// (typed-error encoding lands in a follow-up slice).
	try {
		const overflowed = await counter.Increment({ amount: 20 })
		console.log("Increment(20) [unexpected success]:", overflowed)
	} catch (err) {
		console.log("Increment(20) [expected error]:", err)
	}
}

main().catch((err) => {
	console.error("client smoke test failed:", err)
	process.exit(1)
})

// ------------------------------------------------------------------
// Target Effect Client surface (parked until the client slice lands).
// See plan: /Users/igassmann/.claude/plans/indexed-baking-crescent.md
// ------------------------------------------------------------------
//
// import { Effect } from "effect"
// import { Client } from "@rivetkit/effect"
// import { Counter } from "./actors/mod.ts"
//
// const program = Effect.gen(function* () {
// 	const counterClient = yield* Counter.client
//
// 	const counter = counterClient.getOrCreate(["counter-123"])
//
// 	// Action calls return Effects with types inferred from the schema.
// 	const count = yield* counter.Increment({ amount: 5 })
// 	yield* Effect.log(`Count: ${count}`)
//
// 	const total = yield* counter.GetCount()
// 	yield* Effect.log(`Total: ${total}`)
// })
// // program: Effect<void, CounterOverflowError | RivetError.RivetError, Client>
// //                                                                     ^^^^^^
// //  Missing Client -> compile error naming the central runtime dependency.
//
// // ------------------------------------------------------------------
// // Wiring: provide Client once. Each actor's .client effect
// // uses that transport to create a contract-specific typed accessor.
// // ------------------------------------------------------------------
// const ClientLayer = Client.layer({
// 	endpoint: "https://api.rivet.dev",
// 	token: "...",
// })
//
// program.pipe(Effect.provide(ClientLayer), Effect.runPromise)
