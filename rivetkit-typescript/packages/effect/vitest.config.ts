import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import defaultConfig from "../../../vitest.base";

const here = dirname(fileURLToPath(import.meta.url));

const env = {
	...defaultConfig.test?.env,
	RIVET_ENGINE_BINARY: join(here, "../../../target/debug/rivet-engine"),
};

export default defineConfig({
	...defaultConfig,
	test: {
		...defaultConfig.test,
		env,
		// The in-process Rivet engine binds to a fixed port; serialize
		// test files. Use the default fork pool (per-test isolation) so
		// each test gets a fresh process and a clean engine envoy state.
		fileParallelism: false,
		sequence: { concurrent: false },
		// Kill any orphaned engine + clear state before the suite runs.
		globalSetup: ["./test/globalSetup.ts"],
	},
});
