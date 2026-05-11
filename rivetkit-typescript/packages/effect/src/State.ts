/**
 * `State` is a typed view over an actor's persisted state, plus a
 * subscribable stream of every change.
 *
 * Unlike a `Ref`, `State` has no in-memory cell — the persisted store
 * is the source of truth. Reads decode the live store on demand;
 * writes encode and overwrite it. A `PubSub<A>` backs {@link changes}
 * and is fed externally — the runtime publishes to it from rivetkit's
 * `onStateChange` callback so subscribers see every committed change,
 * including ones initiated outside the SDK.
 *
 * Read and write are Effect-typed so schemas with asynchronous
 * transforms (or service requirements) are supported. `update` and
 * `modify` serialize through a per-`State` semaphore so read/apply/
 * write triples are atomic across fibers; `set` shares the same lock
 * so all writes are linearized.
 *
 * The PubSub uses replay = 1, matching `SubscriptionRef`: a new
 * subscriber immediately sees the most recent value.
 */
import {
	Effect,
	Inspectable,
	identity,
	Pipeable,
	Predicate,
	PubSub,
	Semaphore,
	Stream,
	type Types,
} from "effect";
import { dual } from "effect/Function";

const TypeId = "~@rivetkit/effect/State";

/**
 * A view over a persisted state cell with a subscribable change stream.
 *
 * - `A` — the value type
 * - `R` — the read/write closures' service requirements
 */
export interface State<in out A, out R = never>
	extends State.Variance<A, R>,
		Pipeable.Pipeable,
		Inspectable.Inspectable {
	readonly read: () => Effect.Effect<A, never, R>;
	readonly write: (value: A) => Effect.Effect<void, never, R>;
	readonly pubsub: PubSub.PubSub<A>;
	/**
	 * Serializes writes (`set`, `update`, `modify`) so the read/apply/
	 * write triple is atomic. The runtime may also use this semaphore
	 * to serialize its own decode-and-publish work from
	 * `onStateChange`, keeping the change stream's order consistent
	 * with the write order.
	 */
	readonly semaphore: Semaphore.Semaphore;
}

export const isState = (u: unknown): u is State<unknown> =>
	Predicate.hasProperty(u, TypeId);

export declare namespace State {
	export interface Variance<in out A, out R> {
		readonly [TypeId]: {
			readonly _A: Types.Invariant<A>;
			readonly _R: Types.Covariant<R>;
		};
	}
}

const Proto = {
	...Pipeable.Prototype,
	...Inspectable.BaseProto,
	[TypeId]: { _A: identity, _R: identity },
	toJSON(this: State<unknown, unknown>) {
		return { _id: "State" };
	},
};

/**
 * Creates a `State` from `read` and `write` closures over the
 * underlying store. The closures are responsible for any
 * encoding/decoding; `State` itself is schema-agnostic.
 *
 * The current value (per `read()`) is published to the pubsub on
 * construction so any subscription obtained later replays it.
 *
 * The PubSub is not explicitly shut down — it's reclaimed by GC when
 * the `State` and any subscribers become unreachable.
 */
export const make = <A, R>(
	read: () => Effect.Effect<A, never, R>,
	write: (value: A) => Effect.Effect<void, never, R>,
): Effect.Effect<State<A, R>, never, R> =>
	Effect.gen(function* () {
		const pubsub = yield* PubSub.unbounded<A>({ replay: 1 });
		const initial = yield* read();
		PubSub.publishUnsafe(pubsub, initial);
		const self = Object.create(Proto);
		self.read = read;
		self.write = write;
		self.pubsub = pubsub;
		self.semaphore = Semaphore.makeUnsafe(1);
		return self;
	});

/**
 * Reads the current value.
 */
export const get = <A, R>(self: State<A, R>): Effect.Effect<A, never, R> =>
	self.read();

/**
 * Replaces the value. Serialized with `update` / `modify` so writes
 * happen in invocation order.
 */
export const set: {
	<A>(value: A): <R>(self: State<A, R>) => Effect.Effect<void, never, R>;
	<A, R>(self: State<A, R>, value: A): Effect.Effect<void, never, R>;
} = dual(
	2,
	<A, R>(self: State<A, R>, value: A): Effect.Effect<void, never, R> =>
		Semaphore.withPermit(self.semaphore, self.write(value)),
);

/**
 * Updates the value by applying `f` to the current value. The
 * read/apply/write triple is atomic across fibers.
 */
export const update: {
	<A>(
		f: (a: A) => A,
	): <R>(self: State<A, R>) => Effect.Effect<void, never, R>;
	<A, R>(self: State<A, R>, f: (a: A) => A): Effect.Effect<void, never, R>;
} = dual(
	2,
	<A, R>(self: State<A, R>, f: (a: A) => A): Effect.Effect<void, never, R> =>
		Semaphore.withPermit(
			self.semaphore,
			Effect.flatMap(self.read(), (a) => self.write(f(a))),
		),
);

/**
 * Updates the value by applying `f` and returns the new value. The
 * read/apply/write triple is atomic across fibers.
 */
export const updateAndGet: {
	<A>(f: (a: A) => A): <R>(self: State<A, R>) => Effect.Effect<A, never, R>;
	<A, R>(self: State<A, R>, f: (a: A) => A): Effect.Effect<A, never, R>;
} = dual(
	2,
	<A, R>(self: State<A, R>, f: (a: A) => A): Effect.Effect<A, never, R> =>
		Semaphore.withPermit(
			self.semaphore,
			Effect.flatMap(self.read(), (a) => {
				const next = f(a);
				return Effect.as(self.write(next), next);
			}),
		),
);

/**
 * Atomically replaces the value with the second element of `f(prev)`
 * and returns the first. The read/apply/write triple is atomic across
 * fibers.
 */
export const modify: {
	<A, B>(
		f: (a: A) => readonly [B, A],
	): <R>(self: State<A, R>) => Effect.Effect<B, never, R>;
	<A, R, B>(
		self: State<A, R>,
		f: (a: A) => readonly [B, A],
	): Effect.Effect<B, never, R>;
} = dual(
	2,
	<A, R, B>(
		self: State<A, R>,
		f: (a: A) => readonly [B, A],
	): Effect.Effect<B, never, R> =>
		Semaphore.withPermit(
			self.semaphore,
			Effect.flatMap(self.read(), (a) => {
				const [b, next] = f(a);
				return Effect.as(self.write(next), b);
			}),
		),
);

/**
 * Stream of every value published to this `State`. New subscribers
 * immediately see the most recent value (replay = 1), then every
 * subsequent publish.
 */
export const changes = <A, R>(self: State<A, R>): Stream.Stream<A> =>
	Stream.fromPubSub(self.pubsub);

/**
 * Publish a value to the change stream as an `Effect`. Does not
 * modify the underlying store.
 */
export const publish: {
	<A>(value: A): <R>(self: State<A, R>) => Effect.Effect<boolean>;
	<A, R>(self: State<A, R>, value: A): Effect.Effect<boolean>;
} = dual(
	2,
	<A, R>(self: State<A, R>, value: A): Effect.Effect<boolean> =>
		PubSub.publish(self.pubsub, value),
);

/**
 * Synchronous variant of {@link publish}. Returns `true` when the
 * publish succeeded, `false` if the pubsub is shut down. The runtime
 * uses this from rivetkit's `onStateChange` callback to feed the
 * change stream.
 */
export const publishUnsafe = <A, R>(self: State<A, R>, value: A): boolean =>
	PubSub.publishUnsafe(self.pubsub, value);
