import * as Schema from "effect/Schema";
import * as Getter from "effect/SchemaGetter";
import * as Rivetkit from "rivetkit";

/**
 * The cross-boundary Rivet error. Wraps the underlying
 * `rivetkit.RivetError` instance on its `error` field, preserving
 * `instanceof` checks and direct access to `group` / `code` /
 * `message` / `metadata`.
 *
 * Recover with `Effect.catchTag("RivetError", e => …)` and discriminate
 * on `e.error.group` / `e.error.code`.
 */
export class RivetError extends Schema.TaggedErrorClass<RivetError>()(
	"RivetError",
	{ error: Schema.instanceOf(Rivetkit.RivetError) },
) {}

// On-the-wire envelope: the subset of rivetkit's `RivetErrorLike` that
// crosses the action boundary. `Pick`ing here anchors the codec
// against drift in the canonical wire shape.
type WirePayload = Pick<
	Rivetkit.RivetErrorLike,
	"group" | "code" | "message" | "metadata"
>;

const Wire = Schema.Struct({
	group: Schema.String,
	code: Schema.String,
	message: Schema.String,
	metadata: Schema.optionalKey(Schema.Unknown),
});

/**
 * Wire codec used as the default `defectSchema` for actions. Decodes
 * the `(group, code, message, metadata)` envelope produced by
 * `rivetkit-core`'s defect sanitizer into a `RivetError` instance.
 */
export const RivetErrorFromWire = Wire.pipe(
	Schema.decodeTo(Schema.instanceOf(RivetError), {
		decode: Getter.transform(
			({ group, code, message, metadata }) =>
				new RivetError({
					error: new Rivetkit.RivetError(group, code, message, {
						metadata,
					} satisfies Rivetkit.RivetErrorOptions),
				}),
		),
		encode: Getter.transform((e: RivetError) => {
			const out: WirePayload = {
				group: e.error.group,
				code: e.error.code,
				message: e.error.message,
			};
			if (e.error.metadata !== undefined) out.metadata = e.error.metadata;
			return out;
		}),
	}),
);
