import { Context, Effect, Layer } from "effect";
import * as Rivetkit from "rivetkit";
import * as RivetkitClient from "rivetkit/client";
import type { ActorKeyParam } from "./Actor";
import type { TraceMeta } from "./internal/tracing";

/**
 * Connection options for the Rivet Engine client transport. Mirrors
 * the `(endpoint, token, namespace)` subset of rivetkit's
 * `ClientConfigInput`.
 */
export type ClientOptions = Pick<
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

/**
 * Service holding the rivetkit client transport. Provided once via
 * `Client.layer({ ... })`. Consumed by `Actor.client` to dispatch
 * action calls through a single and shared transport.
 */
export class Client extends Context.Service<
	Client,
	{
		/**
		 * Generic action dispatch. Returns the raw, undecoded result from
		 * the wire. On rejection from the underlying transport, surfaces
		 * the rivetkit `RivetError` instance via `Effect.fail` — the
		 * caller decides whether to decode `metadata` as a typed error or
		 * wrap it through the wire codec.
		 *
		 * `meta`, when provided, rides the wire as the second positional
		 * `args` entry. It's a generic envelope (`ActionMeta`) so the SDK
		 * can grow cross-cutting fields without changing the wire shape.
		 */
		readonly action: (
			params: {
				readonly actorName: string;
				readonly key: ActorKeyParam;
				readonly actionName: string;
				readonly encodedPayload: unknown;
				readonly meta?: ActionMeta;
			} & RivetkitClient.ActorActionOptions,
		) => Effect.Effect<unknown, Rivetkit.RivetError>;
	}
>()("@rivetkit/effect/Client") {
	static readonly layer = (
		options: ClientOptions = {},
	): Layer.Layer<Client> =>
		Layer.effect(
			Client,
			Effect.sync(() => {
				const rivetkitClient = RivetkitClient.createClient(options);
				return Client.of({
					action: ({
						actorName,
						key,
						actionName,
						encodedPayload,
						meta,
					}) =>
						Effect.tryPromise({
							try: () =>
								rivetkitClient
									.getOrCreate(actorName, key)
									.action({
										name: actionName,
										args: meta
											? [encodedPayload, meta]
											: [encodedPayload],
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
						}),
				});
			}),
		);
}

export type ClientService = Client["Service"];
