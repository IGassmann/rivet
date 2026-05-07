import { Schema } from "effect";

export const ActorName = Schema.String.pipe(
	Schema.brand("~@rivetkit/effect/ActorName"),
);

export type ActorName = typeof ActorName.Type;

export const make = (value: string): ActorName => value as ActorName;
