import type { Completion, Suggestion } from "../types.ts";
import { signature } from "./format.ts";
import { flagTable, positionalsOf } from "./parse.ts";
import { endsLine, type Grammar, type ReadContext, type Value } from "./slots.ts";
import { tokenize } from "./tokenize.ts";

/**
 * What fits the token under the caret, by argument position: the values of
 * the next positional, the value after an option flag, or the options not
 * yet used. Filtered by the start of the token as typed up to the caret.
 */
export function complete(grammar: Grammar, line: string, caret: number, ctx: ReadContext): Completion {
	const { tokens, passthrough } = tokenize(line);
	const keys = Object.keys(grammar);
	const slotOf = (key: string) => keys.indexOf(key);
	const tailKey = Object.entries(grammar).find(([, slot]) => endsLine(slot))?.[0];

	const dashes = passthrough === null ? undefined : tokens[tokens.length - 1];
	if (dashes && caret > dashes.end) {
		return {
			replace: { start: caret, end: caret },
			suggestions: [],
			slot: tailKey ? slotOf(tailKey) : null,
		};
	}

	let index = tokens.findIndex((t) => t.start <= caret && caret <= t.end);
	const current = index >= 0 ? tokens[index] : { text: "", start: caret, end: caret };
	if (index < 0) index = tokens.filter((t) => t.end < caret).length;
	const typed = current.text.slice(0, caret - current.start);
	const offer = (suggestions: readonly Suggestion[], slot: number | null): Completion => ({
		replace: { start: current.start, end: current.end },
		suggestions: suggestions.filter((s) => s.insert.startsWith(typed)),
		slot,
	});
	if (index === 0) return offer([], null);

	const flags = flagTable(grammar);
	const positionals = positionalsOf(grammar);
	const used = new Set<string>();
	let next = 0;
	let pending: { readonly key: string; readonly value: Value<unknown> } | null = null;
	for (let i = 1; i < index; i++) {
		const text = tokens[i].text;
		if (pending) {
			pending = null;
			continue;
		}
		if (text.startsWith("--")) {
			const entry = flags.get(text);
			if (!entry) continue;
			used.add(entry.key);
			if ("value" in entry.variant) pending = { key: entry.key, value: entry.variant.value };
			continue;
		}
		if (positionals[next]?.[1].kind !== "rest") next++;
	}
	if (pending) return offer(pending.value.suggest(typed, ctx), slotOf(pending.key));

	const options: Suggestion[] = [...flags.values()]
		.filter((f) => !used.has(f.key))
		.map(({ variant: v }) => ({ insert: v.flag, label: "value" in v ? `${v.flag} ${v.value.label}` : v.flag }));
	if (tailKey) options.push({ insert: "--", label: signature(grammar)[slotOf(tailKey)] });
	if (typed.startsWith("-")) return offer(options, null);

	const positional = positionals[next];
	if (!positional) return offer(options, null);
	const [key, slot] = positional;
	const value = slot.kind === "optional" ? slot.value : slot;
	return offer(value.kind === "positional" ? value.suggest(typed, ctx) : [], slotOf(key));
}
