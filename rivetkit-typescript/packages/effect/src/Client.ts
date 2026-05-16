import { Context, Effect, Layer, Schema } from "effect";
import * as Record from "effect/Record";
import * as Rivetkit from "rivetkit";
import * as RivetkitClient from "rivetkit/client";
import type * as Action from "./Action";
import type * as Actor from "./Actor";
import { rpcSystem, type TraceMeta } from "./internal/tracing";
import * as RivetError from "./RivetError";

const TypeId = "~@rivetkit/effect/Client";

/**
 * Connection options for the Rivet Engine client transport. Mirrors
 * the `(endpoint, token, namespace)` subset of rivetkit's
 * `ClientConfigInput`.
 */
export type Options = Pick<
	RivetkitClient.ClientConfigInput,
	"endpoint" | "token" | "namespace"
>;

/**
 * Per-call metadata envelope shipped as `args[1]` alongside the encoded
 * payload. The SDK currently uses it for trace propagation (`trace`),
 * but it's intentionally extensible so future cross-cutting concerns —
 * idempotency keys, deadlines, custom headers — can land as additional
 * optional fields without changing the wire shape.
 */
export interface ActionMeta {
	readonly trace?: TraceMeta;
}

export interface Client {
	readonly [TypeId]: typeof TypeId;

	readonly makeActorAccessor: <Actions extends Action.AnyWithProps>(
		actor: Actor.Actor<string, Actions>,
	) => Actor.Accessor<Actions>;
}

export const Client: Context.Service<Client, Client> = Context.Service<Client>(
	"@rivetkit/effect/Client",
);

export const make = Effect.fnUntraced(function* (options: Options = {}) {
	const rivetkitClient = yield* Effect.acquireRelease(
		Effect.sync(() => RivetkitClient.createClient(options)),
		(c) => Effect.promise(() => c.dispose()),
	);

	return Client.of({
		[TypeId]: TypeId,
		makeActorAccessor: (actor) => ({
			getOrCreate: (key) => {
				const rivetkitActorHandle = rivetkitClient.getOrCreate(
					actor.name,
					key,
				);

				return Record.fromIterableWith(actor.actions, (action) => {
					const encodePayload = Schema.encodeUnknownEffect(
						action.payloadSchema,
					);
					const decodeSuccess = Schema.decodeUnknownEffect(
						action.successSchema,
					);
					const decodeError = Schema.decodeUnknownEffect(
						action.errorSchema,
					);

					const rpcMethod = `${actor.name}/${action._tag}`;

					return [
						action._tag,
						Effect.fn(rpcMethod, {
							kind: "client",
							attributes: {
								"rpc.system.name": rpcSystem,
								"rpc.method": rpcMethod,
							},
						})(function* (payload: unknown) {
							const span = yield* Effect.currentSpan;
							const meta: ActionMeta = {
								trace: {
									traceId: span.traceId,
									spanId: span.spanId,
									sampled: span.sampled,
								},
							};
							const encodedPayload =
								yield* encodePayload(payload);
							const raw = yield* Effect.tryPromise({
								try: () =>
									rivetkitActorHandle.action({
										name: action._tag,
										args: [encodedPayload, meta],
									}),
								catch: (cause) =>
									cause instanceof Rivetkit.RivetError
										? cause
										: new Rivetkit.RivetError(
												"client",
												"unknown",
												cause instanceof Error
													? cause.message
													: String(cause),
												{
													cause:
														cause instanceof Error
															? cause
															: undefined,
												},
											),
							}).pipe(
								// Try `errorSchema` first against the
								// wire metadata. Fall back to wrapping
								// the raw RivetError via `RivetErrorFromWire`.
								Effect.catch((rivetErr) =>
									decodeError(
										(
											rivetErr as {
												metadata?: unknown;
											}
										).metadata,
									).pipe(
										Effect.matchEffect({
											onSuccess: (typed) =>
												Effect.fail(typed),
											onFailure: () =>
												RivetError.decodeRivetErrorFromWire(
													{
														group: rivetErr.group,
														code: rivetErr.code,
														message:
															rivetErr.message,
														metadata: (
															rivetErr as {
																metadata?: unknown;
															}
														).metadata,
													},
												).pipe(
													Effect.flatMap(Effect.fail),
												),
										}),
									),
								),
							);
							return yield* decodeSuccess(raw);
						}),
					];
				}) as Actor.Handle<(typeof actor.actions)[number]>;
			},
		}),
	});
});

export const layer = (options: Options = {}): Layer.Layer<Client> =>
	Layer.effect(Client, make(options));
