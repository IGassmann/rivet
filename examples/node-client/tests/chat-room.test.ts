import { setupTest } from "rivetkit/test";
import { describe, expect, test } from "vitest";
import { registry } from "../src/index.ts";

// Engine state persists across `setupTest` calls within a vitest run, so we
// derive a unique key per test to keep them isolated.
const uniqueKey = (label: string) =>
	`${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

interface DirectoryEntry {
	name: string;
	openedAt: number;
	closedAt?: number;
}

describe("chat room actor", () => {
	test("createState seeds room from input", async (ctx) => {
		const { client } = await setupTest(ctx, registry);

		const room = client.chatRoom.getOrCreate([uniqueKey("create-state")], {
			createWithInput: { name: "Alpha" },
		});

		expect(await room.getMembers()).toEqual([]);

		await room.join("alice");
		const members = await room.getMembers();
		expect(members).toHaveLength(1);
		expect(members[0]?.name).toBe("alice");
	});

	test("sendMessage runs through completable moderation queue", async (ctx) => {
		const { client } = await setupTest(ctx, registry);

		const room = client.chatRoom.getOrCreate([uniqueKey("clean")], {
			createWithInput: { name: "Clean" },
		});

		const result = await room.sendMessage("alice", "hello world");
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(typeof result.createdAt).toBe("number");
		}
	});

	test("moderator rejects banned words via cross-actor RPC", async (ctx) => {
		const { client } = await setupTest(ctx, registry);

		const room = client.chatRoom.getOrCreate([uniqueKey("blocked")], {
			createWithInput: { name: "Blocked" },
		});

		const result = await room.sendMessage("alice", "this is spam");
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toMatch(/spam/);
		}

		// Blocked messages must not be persisted to the SQLite log.
		expect(await room.getHistory()).toEqual([]);
	});

	test("getHistory reads from the SQLite db", async (ctx) => {
		const { client } = await setupTest(ctx, registry);

		const room = client.chatRoom.getOrCreate([uniqueKey("history")], {
			createWithInput: { name: "History" },
		});

		await room.sendMessage("alice", "first");
		await room.sendMessage("bob", "second");
		await room.sendMessage("carol", "third");

		const history = (await room.getHistory()) as Array<{
			sender: string;
			text: string;
		}>;

		expect(history.map((m) => [m.sender, m.text])).toEqual([
			["alice", "first"],
			["bob", "second"],
			["carol", "third"],
		]);
	});

	test("connect() receives broadcast events", async (ctx) => {
		const { client } = await setupTest(ctx, registry);

		const room = client.chatRoom.getOrCreate([uniqueKey("events")], {
			createWithInput: { name: "Events" },
		});

		const conn = room.connect();
		try {
			const messageReceived = new Promise<{
				sender: string;
				text: string;
			}>((resolve) => {
				conn.on("newMessage", (msg) => resolve(msg));
			});
			const memberJoined = new Promise<{ member: { name: string } }>(
				(resolve) => {
					conn.on("memberJoined", (payload) => resolve(payload));
				},
			);

			await conn.join("alice");
			await conn.sendMessage("alice", "ping");

			expect((await memberJoined).member.name).toBe("alice");
			expect(await messageReceived).toMatchObject({
				sender: "alice",
				text: "ping",
			});
		} finally {
			await conn.dispose();
		}
	});

	test("scheduleAnnouncement broadcasts after the delay", async (ctx) => {
		const { client } = await setupTest(ctx, registry);

		const room = client.chatRoom.getOrCreate([uniqueKey("schedule")], {
			createWithInput: { name: "Schedule" },
		});

		const conn = room.connect();
		try {
			const announcementReceived = new Promise<{ text: string }>(
				(resolve) => {
					conn.on("announcement", (payload) => resolve(payload));
				},
			);

			await conn.scheduleAnnouncement("welcome!", 100);

			expect(await announcementReceived).toEqual({ text: "welcome!" });
		} finally {
			await conn.dispose();
		}
	});

	test("leave removes the member and broadcasts memberLeft", async (ctx) => {
		const { client } = await setupTest(ctx, registry);

		const room = client.chatRoom.getOrCreate([uniqueKey("leave")], {
			createWithInput: { name: "Leave" },
		});

		const conn = room.connect();
		try {
			await conn.join("alice");
			await conn.join("bob");

			const memberLeft = new Promise<{ name: string }>((resolve) => {
				conn.on("memberLeft", (payload) => resolve(payload));
			});

			await conn.leave("alice");

			expect((await memberLeft).name).toBe("alice");
			expect(await conn.getMembers()).toEqual([
				expect.objectContaining({ name: "bob" }),
			]);
		} finally {
			await conn.dispose();
		}
	});

	test("different keys are isolated", async (ctx) => {
		const { client } = await setupTest(ctx, registry);

		const roomA = client.chatRoom.getOrCreate([uniqueKey("isolated-a")], {
			createWithInput: { name: "A" },
		});
		const roomB = client.chatRoom.getOrCreate([uniqueKey("isolated-b")], {
			createWithInput: { name: "B" },
		});

		await roomA.sendMessage("alice", "in a");

		expect(await roomA.getHistory()).toHaveLength(1);
		expect(await roomB.getHistory()).toHaveLength(0);
	});

	test("getForId(resolve()) targets the same instance", async (ctx) => {
		const { client } = await setupTest(ctx, registry);

		const room = client.chatRoom.getOrCreate([uniqueKey("resolve")], {
			createWithInput: { name: "Resolve" },
		});
		await room.join("alice");

		const actorId = await room.resolve();
		const byId = client.chatRoom.getForId(actorId);

		const members = (await byId.getMembers()) as Array<{ name: string }>;
		expect(members.map((m) => m.name)).toEqual(["alice"]);
	});

	test("create() always allocates a fresh actor", async (ctx) => {
		const { client } = await setupTest(ctx, registry);

		const a = await client.chatRoom.create([uniqueKey("create-a")], {
			input: { name: "First" },
		});
		const b = await client.chatRoom.create([uniqueKey("create-b")], {
			input: { name: "Second" },
		});

		expect(await a.resolve()).not.toBe(await b.resolve());
	});
});

describe("moderator actor", () => {
	test("review approves clean text", async (ctx) => {
		const { client } = await setupTest(ctx, registry);
		const moderator = client.moderator.getOrCreate(["main"]);

		const verdict = await moderator.review("hello there");
		expect(verdict.approved).toBe(true);
	});

	test("review rejects text with banned words", async (ctx) => {
		const { client } = await setupTest(ctx, registry);
		const moderator = client.moderator.getOrCreate(["main"]);

		const verdict = await moderator.review("totally a scam");
		expect(verdict.approved).toBe(false);
		if (!verdict.approved) {
			expect(verdict.reason).toMatch(/scam/);
		}
	});

	test("stats counter increments on each review", async (ctx) => {
		const { client } = await setupTest(ctx, registry);
		const moderator = client.moderator.getOrCreate([uniqueKey("stats")]);

		const before = (await moderator.stats()).reviewed;
		await moderator.review("ok");
		await moderator.review("also fine");
		const after = (await moderator.stats()).reviewed;

		expect(after).toBe(before + 2);
	});

	test("chatRoom.sendMessage drives traffic to moderator['main']", async (ctx) => {
		const { client } = await setupTest(ctx, registry);
		const moderator = client.moderator.getOrCreate(["main"]);
		const room = client.chatRoom.getOrCreate([uniqueKey("stats-room")], {
			createWithInput: { name: "Stats Room" },
		});

		const before = (await moderator.stats()).reviewed;
		await room.sendMessage("alice", "hello");
		await room.sendMessage("alice", "again");
		const after = (await moderator.stats()).reviewed;

		expect(after).toBe(before + 2);
	});
});

describe("directory actor", () => {
	test("chatRoom.join registers the room with the directory", async (ctx) => {
		const { client } = await setupTest(ctx, registry);

		const roomName = uniqueKey("Directory Test");
		const room = client.chatRoom.getOrCreate([uniqueKey("directory")], {
			createWithInput: { name: roomName },
		});
		await room.join("alice");

		const dir = client.directory.getOrCreate(["main"]);
		const rooms = (await dir.listRooms()) as DirectoryEntry[];

		expect(rooms.some((r) => r.name === roomName)).toBe(true);
	});

	test("registerRoom is idempotent", async (ctx) => {
		const { client } = await setupTest(ctx, registry);
		const dir = client.directory.getOrCreate([uniqueKey("idempotent")]);
		const roomName = uniqueKey("only-once");

		await dir.registerRoom(roomName);
		await dir.registerRoom(roomName);

		const rooms = (await dir.listRooms()) as DirectoryEntry[];
		expect(rooms.filter((r) => r.name === roomName)).toHaveLength(1);
	});

	test("closeRoom marks the room as closed", async (ctx) => {
		const { client } = await setupTest(ctx, registry);
		const dir = client.directory.getOrCreate([uniqueKey("close-test")]);
		const roomName = uniqueKey("closing");

		await dir.registerRoom(roomName);
		await dir.closeRoom(roomName);

		const rooms = (await dir.listRooms()) as DirectoryEntry[];
		const closed = rooms.find((r) => r.name === roomName);
		expect(closed?.closedAt).toBeTypeOf("number");
	});
});
