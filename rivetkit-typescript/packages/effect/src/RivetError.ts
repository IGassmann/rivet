import * as Schema from "effect/Schema";
import * as Getter from "effect/SchemaGetter";
import { RivetError as RivetErrorClass } from "rivetkit";

const RivetErrorEncoded = Schema.Struct({
	group: Schema.String,
	code: Schema.String,
	message: Schema.String,
	metadata: Schema.optionalKey(Schema.Unknown),
});

/**
 * Schema for the cross-boundary `RivetError` envelope.
 *
 * Decodes to the existing `RivetError` class from `rivetkit`, so any
 * code that catches `instanceof RivetError` keeps working across
 * SDKs.
 *
 * Server-side defects (unexpected throws from action handlers) are
 * sanitized into `RivetError("internal", "internal_error", ...)`
 * before they hit the wire. This is the wire shape the Effect SDK
 * uses as the default `defectSchema` for every action.
 */
export const RivetError = RivetErrorEncoded.pipe(
	Schema.decodeTo(Schema.instanceOf(RivetErrorClass), {
		decode: Getter.transform(({ group, code, message, metadata }) =>
			new RivetErrorClass(group, code, message, { metadata }),
		),
		encode: Getter.transform((e: RivetErrorClass) => {
			const out: {
				group: string;
				code: string;
				message: string;
				metadata?: unknown;
			} = {
				group: e.group,
				code: e.code,
				message: e.message,
			};
			if (e.metadata !== undefined) out.metadata = e.metadata;
			return out;
		}),
	}),
);
