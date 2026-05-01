import { createClient } from "rivetkit/client";
import type { registry } from "./index.ts";

const client = createClient<typeof registry>("http://localhost:6420");

async function main() {
	const counter = client.counter.getOrCreate(["my-counter"]);

	const initial = await counter.getCount();
	console.log("Initial count:", initial);

	const afterIncrement = await counter.increment(5);
	console.log("After +5:", afterIncrement);

	const final = await counter.getCount();
	console.log("Final count:", final);
}

main().catch((error) => {
	console.error("Error:", error);
	process.exit(1);
});
