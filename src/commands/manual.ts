import type { ToolName } from "../model/index.ts";
import { optionTokens, signature, slotSignature } from "./grammar/format.ts";
import { isRequired, lineFromInput } from "./grammar/schema.ts";
import type { Grammar, Slot } from "./grammar/slots.ts";

/** One argument of a verb, under both of its names. */
export interface ManualArgument {
	/** The tool's field: `extraDisk`. */
	readonly field: string;
	/** As it is typed in the bar, in brackets when it can be left out: `[--extra-disk GiB,...]`. */
	readonly written: string;
	readonly about: string;
	readonly required: boolean;
	/** What leaving it out says, or null when `about` says what that does. */
	readonly default: string | null;
}

/** All that help says of a verb. Every part comes from where the parser, the tool and its schema have it. */
export interface Manual {
	readonly verb: string;
	readonly about: string;
	/** Null when only a person has use for the verb. */
	readonly tool: ToolName | null;
	readonly usage: string;
	readonly description: string;
	readonly arguments: readonly ManualArgument[];
	/** One call, as a line and as the tool's input. */
	readonly example: { readonly line: string; readonly input: Example };
}

export type Example = Readonly<Record<string, string | number>>;

type Needed<G extends Grammar> = {
	[K in keyof G]: G[K] extends { readonly kind: "positional" | "passthrough" | "verbatim" } ? K : never;
}[keyof G];

/** A verb's arguments as its tool takes them, with the ones that it needs. */
export type ExampleOf<G extends Grammar> = { readonly [K in Needed<G>]: string | number } & {
	readonly [K in Exclude<keyof G, Needed<G>>]?: string | number;
};

interface Documented {
	readonly name: string;
	readonly about: string;
	readonly description?: string;
	readonly grammar: Grammar;
	readonly tool?: { readonly name: ToolName };
}

function defaultOf(slot: Slot): string | null {
	if (slot.kind !== "options") return null;
	return optionTokens(slot, slot.default) && String(slot.default);
}

export function manualOf(verb: Documented, example: Example): Manual {
	const { name, about, description = about, grammar, tool } = verb;
	const line = lineFromInput(name, grammar, example, example);
	if (typeof line !== "string") throw new Error(`defineVerb(${name}): its example does not read: ${line.message}`);
	return {
		verb: name,
		about,
		tool: tool?.name ?? null,
		usage: [name, ...signature(grammar)].join(" "),
		description,
		arguments: Object.entries(grammar).map(([field, slot]) => ({
			field,
			written: slotSignature(slot),
			about: slot.about,
			required: isRequired(slot),
			default: defaultOf(slot),
		})),
		example: { line, input: example },
	};
}
