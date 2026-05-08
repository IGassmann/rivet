import { Layer } from "effect"
import { NodeRuntime } from "@effect/platform-node"
import { Registry } from "@rivetkit/effect"
import { CounterLive } from "./actors/counter/live.ts"
// import { ChatRoomLive } from "./actors/chat-room/live.ts"

const ActorsLayer = Layer.mergeAll(
	CounterLive,
//	ChatRoomLive,
)

// Engine config defaults to spawning a local rivet-engine process and
// listening on http://127.0.0.1:6420 (override via RIVET_ENDPOINT to
// point at a remote engine). For dev builds without a packaged engine,
// set RIVET_ENGINE_BINARY to the path of a `cargo build` binary, e.g.:
//   RIVET_ENGINE_BINARY=$(pwd)/target/debug/rivet-engine pnpm start
const MainLayer = Registry.serve.pipe(
	Layer.provide(ActorsLayer),
	Layer.provide(Registry.layer()),
)

// Keeps the layer alive. Tears down on SIGINT/SIGTERM.
Layer.launch(MainLayer).pipe(NodeRuntime.runMain)
