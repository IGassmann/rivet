# Platform Test Fixtures

- Platform fixture code should look like public docs code that users can copy.
- Do not expose test-only registry wrapper APIs in generated platform apps.
- Generated platform apps should import `actor`, `setup`, and `@rivetkit/rivetkit-wasm` through public package exports.
- Keep shared helpers for process setup, temporary files, ports, and assertions, not for hiding the public RivetKit runtime API.
- Cloudflare Workers, Supabase Functions, and Deno fixtures should share the same docs-shaped SQLite counter actor source with only platform bootstrapping differences.
- Use `buildPlatformSqliteCounterRegistrySource(...)` when generated apps need the shared docs-shaped SQLite counter registry.
- Do not use hidden globals, lower-level registry builders, private generated wasm paths, or repo-local `pkg*` imports in platform app code.
- Raw `ctx.sql` platform fixtures still need a `db` provider so runtime SQLite is enabled.
- Cloudflare Workers fixtures need a fetch-upgrade `WebSocket` shim for wasm envoy connections.
- Deno fixtures need `--allow-sys` because public `rivetkit` imports `pino`, which reads `os.hostname()`.
- Deno fixtures should load wasm bytes from the public `@rivetkit/rivetkit-wasm/rivetkit_wasm_bg.wasm` export with `import.meta.resolve` plus `Deno.readFile`.
- Supabase Functions fixtures run inside Docker, so advertise the host engine through the Docker bridge IP when `docker0` exists and fall back to `host.docker.internal`.
- Supabase Functions fixtures need package metadata next to the function entrypoint for Edge Runtime bare package resolution.
- Supabase Functions fixtures should use Edge Runtime `per_worker` policy so long-lived serverless start streams can coexist with metadata and wake requests.
- Do not duplicate engine-owned serverless start headers such as `x-rivet-endpoint` in platform runner config.
- Avoid `sqlite_` table names in platform fixtures because SQLite reserves that prefix.
