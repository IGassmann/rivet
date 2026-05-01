import { Layer } from "effect"
import { NodeRuntime } from "@effect/platform-node"
import { Registry, Runner } from "@rivetkit/effect"
import { CounterLive } from "./actors/counter/live.ts"
// import { ChatRoomLive } from "./actors/chat-room/live.ts"

const ActorsLayer = Layer.mergeAll(
	CounterLive,
//	ChatRoomLive,
)

const MainLayer = Runner.start.pipe(
	Layer.provide(ActorsLayer),
	Layer.provide(Registry.layer({ endpoint: "https://api.rivet.dev" })),
)

// Keeps the layer alive. Tears down on SIGINT/SIGTERM.
Layer.launch(MainLayer).pipe(NodeRuntime.runMain)
