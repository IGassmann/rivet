import { actor, event, queue, setup } from "rivetkit";
import { db } from "rivetkit/db";

// Singleton directory tracking which chat rooms are open. Exercised via
// actor-to-actor calls from chatRoom.onDestroy and chatRoom.join.
export const directory = actor({
	state: {
		rooms: [] as Array<{
			name: string;
			openedAt: number;
			closedAt?: number;
		}>,
	},
	actions: {
		registerRoom: (c, name: string) => {
			if (c.state.rooms.some((r) => r.name === name)) return;
			c.state.rooms.push({ name, openedAt: Date.now() });
		},
		closeRoom: (c, name: string) => {
			const room = c.state.rooms.find((r) => r.name === name);
			if (room) room.closedAt = Date.now();
		},
		listRooms: (c) => c.state.rooms,
	},
});

// Moderation service consumed by chat rooms via cross-actor RPC.
export const moderator = actor({
	state: {
		bannedWords: ["spam", "scam"] as string[],
		reviewed: 0,
	},
	actions: {
		review: (c, text: string) => {
			c.state.reviewed += 1;
			const hit = c.state.bannedWords.find((word) =>
				text.toLowerCase().includes(word),
			);
			return hit
				? {
						approved: false as const,
						reason: `contains banned word "${hit}"`,
					}
				: { approved: true as const };
		},
		stats: (c) => ({ reviewed: c.state.reviewed }),
	},
});

interface RoomInput {
	name: string;
}
interface Member {
	name: string;
	joinedAt: number;
}
interface RoomState {
	name: string;
	members: Member[];
	wakeCount: number;
}

export const chatRoom = actor({
	// SQLite-backed message log that survives sleeps and restarts.
	db: db({
		onMigrate: async (db) => {
			await db.execute(`
				CREATE TABLE IF NOT EXISTS messages (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					sender TEXT NOT NULL,
					text TEXT NOT NULL,
					created_at INTEGER NOT NULL
				)
			`);
		},
	}),
	// Persistent state seeded from the createWithInput / input passed by the
	// client on getOrCreate / create.
	createState: (_c, input: RoomInput): RoomState => ({
		name: input.name,
		members: [],
		wakeCount: 0,
	}),
	// Per-instance vars regenerated each wake. Useful for tracing.
	createVars: () => ({
		sessionId: crypto.randomUUID(),
	}),
	events: {
		newMessage: event<{ sender: string; text: string; createdAt: number }>(),
		memberJoined: event<{ member: Member }>(),
		memberLeft: event<{ name: string }>(),
		announcement: event<{ text: string }>(),
	},
	// Completable queue: actions enqueueAndWait, the run loop calls complete().
	queues: {
		moderation: queue<
			{ sender: string; text: string },
			{ approved: boolean; reason?: string }
		>(),
	},
	onWake: (c) => {
		c.state.wakeCount += 1;
		c.log.info({
			msg: "room awake",
			sessionId: c.vars.sessionId,
			wakeCount: c.state.wakeCount,
		});
	},
	onDestroy: async (c) => {
		const client = c.client<typeof registry>();
		await client.directory.getOrCreate(["main"]).closeRoom(c.state.name);
	},
	// Drains moderation messages, reviews each via the moderator actor, then
	// completes the corresponding enqueueAndWait waiter inside sendMessage.
	run: async (c) => {
		const client = c.client<typeof registry>();
		const reviewer = client.moderator.getOrCreate(["main"]);
		for await (const msg of c.queue.iter({
			names: ["moderation"],
			completable: true,
		})) {
			const verdict = await reviewer.review(msg.body.text);
			await msg.complete(verdict);
		}
	},
	actions: {
		join: async (c, name: string): Promise<Member> => {
			const member: Member = { name, joinedAt: Date.now() };
			c.state.members.push(member);
			c.broadcast("memberJoined", { member });
			const client = c.client<typeof registry>();
			await client.directory
				.getOrCreate(["main"])
				.registerRoom(c.state.name);
			return member;
		},
		leave: (c, name: string) => {
			c.state.members = c.state.members.filter((m) => m.name !== name);
			c.broadcast("memberLeft", { name });
		},
		// Sends the message through the moderation pipeline before persisting.
		// The action returns only after the run loop completes the queue entry.
		sendMessage: async (c, sender: string, text: string) => {
			const verdict = await c.queue.enqueueAndWait(
				"moderation",
				{ sender, text },
				{ timeout: 10_000 },
			);
			if (!verdict) {
				throw new Error("moderation timed out");
			}
			if (!verdict.approved) {
				return { ok: false as const, reason: verdict.reason };
			}
			const createdAt = Date.now();
			await c.db.execute(
				"INSERT INTO messages (sender, text, created_at) VALUES (?, ?, ?)",
				sender,
				text,
				createdAt,
			);
			c.broadcast("newMessage", { sender, text, createdAt });
			return { ok: true as const, createdAt };
		},
		getHistory: async (c) =>
			c.db.execute(
				"SELECT id, sender, text, created_at as createdAt FROM messages ORDER BY id",
			),
		getMembers: (c) => c.state.members,
		// Schedules a future broadcast. Implemented via c.schedule.after, which
		// dispatches the named action with the supplied args.
		scheduleAnnouncement: (c, text: string, delayMs: number) => {
			c.schedule.after(delayMs, "triggerAnnouncement", text);
			return { firesAt: Date.now() + delayMs };
		},
		triggerAnnouncement: (c, text: string) => {
			c.broadcast("announcement", { text });
		},
		archive: (c) => {
			c.destroy();
		},
	},
});

export const registry = setup({
	use: { chatRoom, moderator, directory },
	startEngine: true,
});

registry.start();
