import type { Grammar, Options, Slot } from "./slots.ts";

function slotSignature(slot: Slot): string {
	switch (slot.kind) {
		case "positional":
		case "rest":
			return `<${slot.label}>`;
		case "options":
			return `[${slot.variants.map((v) => ("value" in v ? `${v.flag} ${v.value.label}` : v.flag)).join(" | ")}]`;
		case "passthrough":
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
	const valued = slot.variants.find((v) => "value" in v);
	return valued && "value" in valued ? [valued.flag, valued.value.format(value)] : null;
}

/** The inverse of parse: positionals in order, options that differ from their default, then `-- passthrough`. */
export function format(verb: string, grammar: Grammar, args: Readonly<Record<string, unknown>>): string {
	const words = [verb];
	const options: string[] = [];
	let passthrough: string | null = null;
	for (const [key, slot] of Object.entries(grammar)) {
		const value = args[key];
		switch (slot.kind) {
			case "positional":
				words.push(slot.format(value));
				break;
			case "rest":
				if (value !== "") words.push(String(value));
				break;
			case "options":
				if (!Object.is(value, slot.default)) options.push(...(optionTokens(slot, value) ?? []));
				break;
			case "passthrough":
				passthrough = String(value);
				break;
		}
	}
	return [...words, ...options, ...(passthrough === null ? [] : ["--", passthrough])].join(" ");
}
