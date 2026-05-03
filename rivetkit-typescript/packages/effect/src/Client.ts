import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Rivetkit from "rivetkit";
import * as RivetkitClient from "rivetkit/client";

/**
 * Connection options for the Rivet Engine client transport. Mirrors
 * `EngineOptions` on the server side: an optional endpoint (with URL
 * auth syntax for namespace and token), plus standalone `token` and
 * `namespace` fields. All fields are optional and fall back to the
 * matching `RIVET_*` environment variables.
 */
export interface ClientOptions {
	/**
	 * Endpoint URL of the Rivet Engine.
	 *
	 * Supports URL auth syntax for namespace and token:
	 * - `https://namespace:token@api.rivet.dev`
	 * - `https://namespace@api.rivet.dev`
	 *
	 * Falls back to `RIVET_ENDPOINT`, then `http://localhost:6420`.
	 */
	readonly endpoint?: string;
	/** Auth token. Falls back to `RIVET_TOKEN`. */
	readonly token?: string;
	/** Namespace. Falls back to `RIVET_NAMESPACE`, then `"default"`. */
	readonly namespace?: string;
}

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
		readonly key: string | ReadonlyArray<string>;
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
				const native = RivetkitClient.createClient<any>(options) as any;
				const callAction: ClientShape["callAction"] = ({
					actorName,
					key,
					actionName,
					encodedPayload,
				}) =>
					Effect.tryPromise({
						try: () =>
							native[actorName].getOrCreate(key).action({
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
