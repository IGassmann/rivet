// Raw-transport smoke test against the Effect example server. Useful
// as an "is the engine alive at all?" diagnostic when the Effect
// client surface in `client.ts` misbehaves. Drives the server using
// a plain rivetkit client with no Effect machinery.
//
//   # terminal A — start the server (auto-spawns local engine)
//   RIVET_RUN_ENGINE=1 \
//   RIVET_ENGINE_BINARY=$(git rev-parse --show-toplevel)/target/debug/rivet-engine \
//   pnpm start
//
//   # terminal B — drive the raw client
//   pnpm client:raw
import { createClient } from "rivetkit/client"

const client = createClient("http://127.0.0.1:6420") as any

async function main() {
	const counter = client.Counter.getOrCreate("counter-raw")

	const initial = await counter.GetCount()
	console.log("GetCount (initial):", initial)

	const afterFive = await counter.Increment({ amount: 5 })
	console.log("Increment(5):", afterFive)

	const afterEight = await counter.Increment({ amount: 3 })
	console.log("Increment(3):", afterEight)

	const total = await counter.GetCount()
	console.log("GetCount (total):", total)

	// Trigger overflow (limit: 20). Plain client surfaces this as a
	// thrown rivetkit RivetError; group should be "user" once typed
	// errors are wired and "actor" otherwise.
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
