import { Schema } from "effect";
import { Action, Actor } from "@rivetkit/effect";

export const ModerationVerdict = Schema.Struct({
	approved: Schema.Boolean,
	reason: Schema.optionalKey(Schema.String),
});

export const Review = Action.make("Review", {
	payload: { text: Schema.String },
	success: ModerationVerdict,
});

export const Stats = Action.make("Stats", {
	success: Schema.Struct({
		reviewed: Schema.Number,
	}),
});

export const Moderator = Actor.make("moderator", {
	actions: [Review, Stats],
});

