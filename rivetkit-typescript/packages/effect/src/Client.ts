import { Context, Effect, Layer } from "effect";
import * as Rivetkit from "rivetkit";
import * as RivetkitClient from "rivetkit/client";
import type { ActorKeyParam } from "./Actor";

/**
 * Connection options for the Rivet Engine client transport. Mirrors
 * the `(endpoint, token, namespace)` subset of rivetkit's
 * `ClientConfigInput` — the only fields the Effect SDK currently
 * surfaces and forwards.
 */
export type ClientOptions = Pick<
	RivetkitClient.ClientConfigInput,
	"endpoint" | "token" | "namespace"
>;

export interface ClientShape {
	/**
	 * Generic action dispatch. Returns the raw, undecoded result from
	 * the wire. On rejection from the underlying transport, surfaces
	 * the rivetkit `RivetError` instance via `Effect.fail` — the
	 * caller decides whether to decode `metadata` as a typed error or
	 * wrap it through the wire codec.
	 */
	readonly callAction: (params: {
		readonly actorName: string;
		readonly key: ActorKeyParam;
		readonly actionName: string;
		readonly encodedPayload: unknown;
	}) => Effect.Effect<unknown, Rivetkit.RivetError>;
}

/**
 * Service holding the rivetkit client transport. Provided once via
 * `Client.layer({ ... })`. Consumed by `Actor.client` to dispatch
 * action calls through a single shared transport.
 */
export class Client extends Context.Service<Client, ClientShape>()(
	"@rivetkit/effect/Client",
) {
	static layer(options: ClientOptions = {}): Layer.Layer<Client> {
		return Layer.effect(
			Client,
			Effect.sync(() => {
				const rivetkitClient = RivetkitClient.createClient<any>(
					options,
				) as any;
				const callAction: ClientShape["callAction"] = ({
					actorName,
					key,
					actionName,
					encodedPayload,
				}) =>
					Effect.tryPromise({
						try: () =>
							rivetkitClient[actorName].getOrCreate(key).action({
								name: actionName,
								args: [encodedPayload],
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
					});
				return Client.of({ callAction });
			}),
		);
	}
}
