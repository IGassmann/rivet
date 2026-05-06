import { createClient } from "rivetkit/client";
import type { registry } from "./index.ts";

const client = createClient<typeof registry>("http://localhost:6420");

async function main() {
	// getOrCreate: returns a stateless handle, seeding the actor with input
	// the first time it is materialized via createState.
	const room = client.chatRoom.getOrCreate(["general"], {
		createWithInput: { name: "General" },
	});

	// resolve(): turns a key-based handle into the underlying actor id, useful
	// for caching or for re-deriving a handle later via getForId.
	const roomId = await room.resolve();
	console.log("room actor id:", roomId);

	// get(): a key-based handle that does NOT auto-create; safe here because
	// getOrCreate above just materialized the actor.
	const sameRoom = client.chatRoom.get(["general"]);
	console.log("members so far:", await sameRoom.getMembers());

	// create(): always allocates a fresh actor for the supplied key.
	const ephemeral = await client.chatRoom.create(
		[`scratch-${Date.now()}`],
		{ input: { name: "Scratch" } },
	);
	const ephemeralId = await ephemeral.resolve();
	console.log("ephemeral room id:", ephemeralId);

	// connect(): opens a stateful WebSocket connection. Subscriptions are
	// registered via .on(name, handler); actions can be invoked over the same
	// connection just like on a stateless handle.
	const conn = room.connect();
	conn.on("memberJoined", ({ member }) =>
		console.log(`-> ${member.name} joined`),
	);
	conn.on("memberLeft", ({ name }) => console.log(`<- ${name} left`));
	conn.on("newMessage", (msg) =>
		console.log(`[${msg.sender}] ${msg.text}`),
	);
	conn.on("announcement", ({ text }) =>
		console.log(`** announcement: ${text} **`),
	);

	// Action over the connection. Triggers a memberJoined broadcast.
	await conn.join("alice");

	// Completable round-trip. sendMessage internally calls
	// c.queue.enqueueAndWait("moderation", ...). The run loop pulls the
	// message with `completable: true` and calls msg.complete(verdict);
	// only then does this await resolve.
	console.log("send (clean):", await conn.sendMessage("alice", "hello world!"));
	console.log(
		"send (blocked):",
		await conn.sendMessage("alice", "this is a spam test"),
	);

	// Scheduled action: server broadcasts an announcement after a delay.
	await conn.scheduleAnnouncement("welcome to the channel", 500);
	await new Promise((resolve) => setTimeout(resolve, 1000));

	// Read persistent message history straight from the actor's SQLite db.
	console.log("history:", await conn.getHistory());

	// getForId(): re-derives a handle from a known actor id. Useful when you
	// previously stored an id and want to talk to that exact instance.
	const byId = client.chatRoom.getForId(roomId);
	console.log("members via id handle:", await byId.getMembers());

	// Cross-actor visibility: directory was registered by chatRoom.join.
	const dir = client.directory.getOrCreate(["main"]);
	console.log("rooms in directory:", await dir.listRooms());

	// Moderator stats reflect every review the room delegated to it.
	const moderatorStats = await client.moderator
		.getOrCreate(["main"])
		.stats();
	console.log("moderator stats:", moderatorStats);

	await conn.dispose();
	await ephemeral.archive();
}

main().catch((error) => {
	console.error("error:", error);
	process.exit(1);
});
