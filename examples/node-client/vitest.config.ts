import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["tests/**/*.test.ts"],
		// setupTest re-spawns the local engine binary for every test, and the
		// first action against a freshly-restarted engine occasionally hits the
		// guard.service_unavailable retry window before the router is fully
		// wired. Retry transient warm-up failures.
		retry: 2,
		testTimeout: 30_000,
	},
});
