import { type LineError, lineError, type Token, type Tokenized } from "../types.ts";
import { oneEditFix } from "./fix.ts";
import { optionTokens, slotSignature } from "./format.ts";
import {
	type ArgsOf,
	endsLine,
	type Grammar,
	list,
	Miss,
	type Optional,
	type Options,
	type ReadContext,
	type Rest,
	type Slot,
	type Value,
	type Variant,
} from "./slots.ts";

export interface Parsed<Args> {
	readonly args: Args;
	/** Option groups left out, written as their defaults: `['--mem 256', '--net switch0']`. */
	readonly assumed: readonly string[];
	/** The token each argument came from, so an error found later can still point at it. */
	readonly tokenOf: Readonly<Partial<Record<keyof Args, number>>>;
}

type Read = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: LineError };

interface FlagEntry {
	readonly key: string;
	readonly slot: Options<unknown>;
	readonly variant: Variant<unknown>;
}

export function flagTable(grammar: Grammar): ReadonlyMap<string, FlagEntry> {
	const table = new Map<string, FlagEntry>();
	for (const [key, slot] of Object.entries(grammar)) {
		if (slot.kind !== "options") continue;
		for (const variant of slot.variants) table.set(variant.flag, { key, slot, variant });
	}
	return table;
}

type Plain = Value<unknown> | Optional<unknown> | Rest;

export function isPlain(slot: Slot): slot is Plain {
	return slot.kind === "positional" || slot.kind === "optional" || slot.kind === "rest";
}

export function positionalsOf(grammar: Grammar): readonly (readonly [string, Plain])[] {
	return Object.entries(grammar).flatMap(([key, slot]) => (isPlain(slot) ? [[key, slot] as const] : []));
}

export function expectedOf(value: Value<unknown>, ctx: ReadContext): readonly string[] {
	return value.suggest("", ctx).map((s) => s.insert);
}

/**
 * Plain tokens fill the positional slots in order; `--flag` tokens fill
 * option groups wherever they appear; a bare `--` hands the rest to the
 * passthrough slot. The first token that does not fit is the error.
 */
function hasControl(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code < 0x20 || code === 0x7f) return true;
	}
	return false;
}

export function parse<G extends Grammar>(
	grammar: G,
	tokenized: Tokenized,
	ctx: ReadContext,
): Parsed<ArgsOf<G>> | LineError {
	const { verb } = ctx;
	const { line, tokens } = tokenized;
	const entries = Object.entries(grammar);
	const positionals = positionalsOf(grammar);
	const flags = flagTable(grammar);
	const values: Record<string, unknown> = {};
	const tokenOf: Record<string, number> = {};
	const rest: number[] = [];
	let next = 0;

	const fail = (message: string, index?: number, expected?: readonly string[], part?: Miss["part"]): LineError => {
		const token = index === undefined ? undefined : tokens[index];
		return lineError(message, index, token && expected ? oneEditFix(line, token, expected, part) : undefined);
	};
	const read = (value: Value<unknown>, token: Token, index: number, where: string): Read => {
		const result = value.read(token.text, ctx);
		if (!(result instanceof Miss)) return { ok: true, value: result };
		const message = result.message ?? `${verb} wants ${value.noun} ${where}, not ${token.text}.`;
		return { ok: false, error: fail(message, index, result.fixable ? expectedOf(value, ctx) : undefined, result.part) };
	};

	for (let i = 1; i < tokens.length; i++) {
		const token = tokens[i];
		if (token.text === "--") break;

		if (token.text.startsWith("--")) {
			const entry = flags.get(token.text);
			if (!entry) {
				const unused = [...flags.values()].filter((f) => !(f.key in tokenOf)).map((f) => f.variant.flag);
				const instead = unused.length === 0 ? "so leave it out" : `so use ${list(unused, "or")}`;
				return fail(`${verb} has no option ${token.text}, ${instead}.`, i, unused);
			}
			if (entry.key in tokenOf) {
				const group = entry.slot.variants.map((v) => v.flag);
				const message =
					group.length > 1 ? `${verb} takes ${list(group, "or")}, not both.` : `${verb} takes ${token.text} once.`;
				return fail(message, i);
			}
			tokenOf[entry.key] = i;
			const { variant } = entry;
			if ("constant" in variant) {
				values[entry.key] = variant.constant;
				continue;
			}
			const valueToken = tokens[i + 1];
			if (!valueToken || valueToken.text.startsWith("--")) {
				return fail(`${verb} wants ${variant.value.noun} after ${variant.flag}.`, i);
			}
			i++;
			const value = read(variant.value, valueToken, i, `after ${variant.flag}`);
			if (!value.ok) return value.error;
			values[entry.key] = value.value;
			continue;
		}

		const positional = positionals[next];
		if (!positional) {
			const takes = positionals.length === 0 ? "no arguments" : positionals.map(([, s]) => slotSignature(s)).join(" ");
			return fail(`${verb} takes ${takes}, so leave out ${token.text}.`, i);
		}
		const [key, slot] = positional;
		tokenOf[key] ??= i;
		if (slot.kind === "rest") {
			rest.push(i);
			continue;
		}
		const value = read(slot.kind === "optional" ? slot.value : slot, token, i, "here");
		if (!value.ok) return value.error;
		values[key] = value.value;
		next++;
	}

	const assumed: string[] = [];
	const dashes = tokenized.passthrough === null ? undefined : tokens.length - 1;
	for (const [key, slot] of entries) {
		switch (slot.kind) {
			case "positional":
				if (!(key in values)) return fail(`${verb} needs ${slot.noun}.`);
				break;
			case "optional":
				values[key] ??= null;
				break;
			case "rest": {
				const text = rest.map((i) => tokens[i].text).join(" ");
				const fault = slot.check?.(text, ctx);
				if (fault) {
					const before = text.slice(0, fault.start).split(" ").length - 1;
					return fail(fault.message, rest[before], fault.instead);
				}
				values[key] = text;
				break;
			}
			case "options":
				if (!(key in values)) {
					values[key] = slot.default;
					const said = optionTokens(slot, slot.default);
					if (said) assumed.push(said.join(" "));
				}
				break;
			case "passthrough": {
				const typed = tokenized.passthrough?.trimStart();
				if (!typed) return fail(`${verb} wants a ${slot.label} after --.`, dashes);
				// Typed into a terminal, a control character edits or runs the line where no one can see it.
				if (hasControl(typed)) {
					return fail(`${verb} wants a ${slot.label} of printable characters after --.`, dashes);
				}
				values[key] = typed;
				tokenOf[key] = tokens.length - 1;
				break;
			}
			case "verbatim":
				if (tokenized.passthrough === null) return fail(`${verb} wants a ${slot.label} after --.`);
				values[key] = tokenized.passthrough;
				tokenOf[key] = tokens.length - 1;
				break;
		}
	}
	if (dashes !== undefined && !entries.some(([, slot]) => endsLine(slot))) {
		return fail(`${verb} takes nothing after --, so leave it out.`, dashes);
	}

	// Each slot above filled exactly its own key with a value it read and checked, so this is ArgsOf<G>.
	return { args: values as ArgsOf<G>, assumed, tokenOf: tokenOf as Parsed<ArgsOf<G>>["tokenOf"] };
}
