import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Vitest globalSetup that kills any orphaned `rivet-engine` process and
 * clears the engine's on-disk state before the test suite runs.
 *
 * The Rivet engine spawned by `setupTest` is intentionally orphaned and
 * outlives the test process; it persists envoy registrations, actor
 * pools, and database state in `~/.rivetkit`. Without a clean slate
 * each invocation, the second-and-subsequent test runs inherit stale
 * envoy registrations from prior runs and the runner pool fails to
 * become available, surfacing as `actor_ready_timeout` / `no_envoys`
 * for any test that exercises the wire path.
 */
export default function globalSetup() {
	try {
		spawnSync("pkill", ["-9", "-f", "rivet-engine"], { stdio: "ignore" });
	} catch {}
	try {
		rmSync(join(homedir(), ".rivetkit"), { recursive: true, force: true });
	} catch {}
}
