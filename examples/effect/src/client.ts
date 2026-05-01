import { Effect } from "effect"
import { Client } from "@rivetkit/effect"
import { Counter /*, IncrementBy */ } from "./actors/counter/api.ts"

const program = Effect.gen(function* () {
	const counterClient = yield* Counter.client
	const counter = counterClient.getOrCreate(["counter-effect"])

	const count = yield* counter.Increment({ amount: 5 })
	yield* Effect.log(`Increment(5) -> ${count}`)

	const total = yield* counter.GetCount()
	yield* Effect.log(`GetCount -> ${total}`)

	// const newCount = yield* counter.send(IncrementBy({ amount: 3 }))
	// yield* Effect.log(`IncrementBy(3) -> ${newCount}`)
	//
	// // subscribe returns a Stream typed from the event schema.
	// yield* counter.subscribe("countChanged").pipe(
	// 	Stream.take(3),
	// 	Stream.runForEach((n) => Effect.log(`countChanged: ${n}`)),
	// )

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
