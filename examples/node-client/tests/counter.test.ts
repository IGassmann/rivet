import { setupTest } from "rivetkit/test";
import { describe, expect, test } from "vitest";
import { registry } from "../src/index.ts";

describe("counter actor", () => {
	test("starts at zero", async (ctx) => {
		const { client } = await setupTest(ctx, registry);

		const counter = client.counter.getOrCreate(["fresh"]);

		expect(await counter.getCount()).toBe(0);
	});

	test("increment returns the new total", async (ctx) => {
		const { client } = await setupTest(ctx, registry);

		const counter = client.counter.getOrCreate(["increments"]);

		expect(await counter.increment(3)).toBe(3);
		expect(await counter.increment(7)).toBe(10);
	});

	test("state persists across handle re-resolution", async (ctx) => {
		const { client } = await setupTest(ctx, registry);

		await client.counter.getOrCreate(["persist"]).increment(5);

		const reResolved = client.counter.getOrCreate(["persist"]);
		expect(await reResolved.getCount()).toBe(5);
	});

	test("different keys are isolated", async (ctx) => {
		const { client } = await setupTest(ctx, registry);

		await client.counter.getOrCreate(["a"]).increment(1);
		await client.counter.getOrCreate(["b"]).increment(99);

		expect(await client.counter.getOrCreate(["a"]).getCount()).toBe(1);
		expect(await client.counter.getOrCreate(["b"]).getCount()).toBe(99);
	});

	test("supports negative increments", async (ctx) => {
		const { client } = await setupTest(ctx, registry);

		const counter = client.counter.getOrCreate(["signed"]);

		await counter.increment(10);
		expect(await counter.increment(-4)).toBe(6);
	});
});
