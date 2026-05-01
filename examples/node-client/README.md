# Node Client

A minimal RivetKit example with no UI framework. The actor lives in `src/index.ts` and a plain Node script in `src/client.ts` connects to it via `rivetkit/client`.

## Getting Started

```sh
git clone https://github.com/rivet-dev/rivet.git
cd rivet/examples/node-client
pnpm install
pnpm dev          # starts the actor envoy + spawns a local engine
pnpm client       # in another terminal: runs the client script
```

The example sets `startEngine: true`, so the registry spawns the engine binary itself. When running from this monorepo (no published platform package installed), point `RIVET_ENGINE_BINARY` at the workspace dev build:

```sh
RIVET_ENGINE_BINARY=$(pwd)/../../target/debug/rivet-engine pnpm dev
```

## Features

- **Actor definition**: Counter actor with persistent state and two actions
- **Type-safe client**: `createClient<typeof registry>(endpoint)` for end-to-end type inference
- **No UI framework**: Pure Node script, suitable as a starting point for CLIs, scripts, or backend-to-actor calls

## Implementation

- **Actor + registry** ([`src/index.ts`](https://github.com/rivet-dev/rivet/tree/main/examples/node-client/src/index.ts))
- **Client script** ([`src/client.ts`](https://github.com/rivet-dev/rivet/tree/main/examples/node-client/src/client.ts))
- **Tests** ([`tests/counter.test.ts`](https://github.com/rivet-dev/rivet/tree/main/examples/node-client/tests/counter.test.ts))

## Resources

Read more about [actions](/docs/actors/actions), [state](/docs/actors/state), and [the client](/docs/clients).

## License

MIT
