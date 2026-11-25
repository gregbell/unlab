import type { Grammar, Options, Slot } from "./slots.ts";
import { tokenize } from "./tokenize.ts";

/** `<image>`, `[--net network,... | --no-net]`, `-- <command>` */
export function slotSignature(slot: Slot): string {
	switch (slot.kind) {
		case "positional":
		case "rest":
			return `<${slot.label}>`;
		case "optional":
			return `[${slot.value.label}]`;
		case "options":
			return `[${slot.variants.map((v) => ("value" in v ? `${v.flag} ${v.value.label}` : v.flag)).join(" | ")}]`;
		case "passthrough":
		case "verbatim":
			return `-- <${slot.label}>`;
	}
}

/** `['<count>', '<image>', '[--mem MiB]', '[--net switch0 | --no-net]']` */
export function signature(grammar: Grammar): readonly string[] {
	return Object.values(grammar).map(slotSignature);
}

/** The tokens that say `value` for an option group, or null when no flag can say it (`focus`'s plain mode). */
export function optionTokens(slot: Options<unknown>, value: unknown): readonly string[] | null {
	const bare = slot.variants.find((v) => "constant" in v && Object.is(v.constant, value));
	if (bare) return [bare.flag];
	if (value === null) return null;
	const valued = slot.variants.find((v) => "value" in v);
	return valued && "value" in valued ? [valued.flag, valued.value.format(value)] : null;
}

/** The most characters of a text that a line shows. */
const SHOWN_MAX = 200;

/** Whether a text reads as part of a line: short, on one line, and nothing in it that does not show. */
function reads(text: string): boolean {
	return text.length <= SHOWN_MAX && !/[\p{C}\p{Zl}\p{Zp}]/u.test(text);
}

/** A line that a log or a panel shows, and the text that it leaves out. */
export interface Shown {
	readonly line: string;
	readonly text: string | null;
}

/** A text that does not read as part of its line is left out with its `--`, so the line cannot be run again as it is. */
export function shown(grammar: Grammar, line: string): Shown {
	const { tokens, passthrough } = tokenize(line);
	const dashes = tokens.at(-1);
	const verbatim = Object.values(grammar).some((slot) => slot.kind === "verbatim");
	if (!verbatim || !dashes || passthrough === null || reads(passthrough)) return { line, text: null };
	return { line: line.slice(0, dashes.start).trimEnd(), text: passthrough };
}

/** The inverse of parse: positionals in order, options that differ from their default, then `-- passthrough`. */
export function format(verb: string, grammar: Grammar, args: Readonly<Record<string, unknown>>): string {
	const words = [verb];
	const options: string[] = [];
	let tail: string | null = null;
	for (const [key, slot] of Object.entries(grammar)) {
		const value = args[key];
		switch (slot.kind) {
			case "positional":
				words.push(slot.format(value));
				break;
			case "optional":
				if (value !== null) words.push(slot.value.format(value));
				break;
			case "rest":
				if (value !== "") words.push(String(value));
				break;
			case "options":
				if (!Object.is(value, slot.default)) options.push(...(optionTokens(slot, value) ?? []));
				break;
			case "passthrough":
			case "verbatim":
				tail = String(value);
				break;
		}
	}
	return [...words, ...options, ...(tail === null ? [] : ["--", tail])].join(" ");
}
