import { randomUUID } from "node:crypto";
import {
	getOrStartSharedTestEngine,
	releaseSharedTestEngine,
	type SharedTestEngine,
	TEST_ENGINE_TOKEN,
} from "../../rivetkit/tests/shared-engine";

export { getOrStartSharedTestEngine, releaseSharedTestEngine, TEST_ENGINE_TOKEN };
export type { SharedTestEngine };

export interface PreparedNamespace {
	readonly endpoint: string;
	readonly token: string;
	readonly namespace: string;
	readonly poolName: string;
}

// Mirrors what `setupTest` + `startEngine: true` does internally
// (`rivetkit-core::registry::runner_config::ensure_local_normal_runner_config`):
// reuses the engine's bootstrap-created `default` namespace and only
// upserts a normal runner config with the same body shape core emits.
// Per-file isolation comes from a unique pool name; the registry
// registers its envoy under that pool so envoy routing stays partitioned
// across test files even though they share the namespace.
//
// The engine's `/health` route returns OK as soon as the HTTP servers
// are listening, but the bootstrap workflows (epoxy replica/coordinator,
// default namespace, datacenter ping) keep running in the background.
// Actor wakes need those workflows settled or the first SQLite
// `get_pages` against a fresh bucket fails with `sqlite database was
// not found in this bucket branch`. Probe `getDatacenters` plus an
// idempotent runner-config upsert with `drain_on_version_upgrade: true`
// until both succeed back-to-back; bootstrap is settled by then.
export async function prepareNamespace(
	endpoint: string,
	options: { poolName?: string } = {},
): Promise<PreparedNamespace> {
	const namespace = "default";
	const poolName = options.poolName ?? `effect-e2e-${randomUUID()}`;
	await upsertNormalRunnerConfig(endpoint, namespace, poolName);
	return { endpoint, token: TEST_ENGINE_TOKEN, namespace, poolName };
}

export async function waitForEnvoy(
	endpoint: string,
	namespace: string,
	poolName: string,
	timeoutMs = 30_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		const response = await fetch(
			`${endpoint}/envoys?namespace=${encodeURIComponent(namespace)}&name=${encodeURIComponent(poolName)}`,
			{
				headers: {
					Authorization: `Bearer ${TEST_ENGINE_TOKEN}`,
				},
			},
		);

		if (response.ok) {
			const body = (await response.json()) as {
				envoys: Array<{ envoy_key: string }>;
			};
			if (body.envoys.length > 0) return;
		}

		await new Promise((resolve) => setTimeout(resolve, 250));
	}

	throw new Error(
		`timed out waiting for envoy in pool ${poolName} (namespace ${namespace})`,
	);
}

async function upsertNormalRunnerConfig(
	endpoint: string,
	namespace: string,
	poolName: string,
): Promise<void> {
	const datacentersResponse = await fetch(
		`${endpoint}/datacenters?namespace=${encodeURIComponent(namespace)}`,
		{
			headers: {
				Authorization: `Bearer ${TEST_ENGINE_TOKEN}`,
			},
		},
	);

	if (!datacentersResponse.ok) {
		throw new Error(
			`failed to list datacenters: ${datacentersResponse.status} ${await datacentersResponse.text()}`,
		);
	}

	const datacentersBody = (await datacentersResponse.json()) as {
		datacenters: Array<{ name: string }>;
	};
	const datacenter = datacentersBody.datacenters[0]?.name;

	if (!datacenter) {
		throw new Error("engine returned no datacenters");
	}

	const deadline = Date.now() + 30_000;

	while (Date.now() < deadline) {
		const response = await fetch(
			`${endpoint}/runner-configs/${encodeURIComponent(poolName)}?namespace=${encodeURIComponent(namespace)}`,
			{
				method: "PUT",
				headers: {
					Authorization: `Bearer ${TEST_ENGINE_TOKEN}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					datacenters: {
						[datacenter]: {
							normal: {},
							drain_on_version_upgrade: true,
						},
					},
				}),
			},
		);

		if (response.ok) {
			return;
		}

		const responseBody = await response.text();
		// The engine briefly reports the just-created namespace as missing
		// or returns a transient internal_error before the create write
		// propagates. Match the driver harness pattern and retry both.
		if (
			(response.status === 400 &&
				responseBody.includes('"group":"namespace"') &&
				responseBody.includes('"code":"not_found"')) ||
			(response.status === 500 &&
				responseBody.includes('"group":"core"') &&
				responseBody.includes('"code":"internal_error"'))
		) {
			await new Promise((resolve) => setTimeout(resolve, 500));
			continue;
		}

		throw new Error(
			`failed to upsert runner config ${poolName}: ${response.status} ${responseBody}`,
		);
	}

	throw new Error(`timed out upserting runner config ${poolName}`);
}
