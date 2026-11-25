import type { Example } from "../manual.ts";
import { type JsonSchema, type LineError, lineError } from "../types.ts";
import { endsLine, type Grammar, list, type Options, type Slot, type Value } from "./slots.ts";

type Shape = Omit<JsonSchema, "description">;

function optionsShape(slot: Options<unknown>): Shape {
	const shapes = slot.variants.map((v): Shape => {
		if ("value" in v) return v.value.schema;
		return { type: "string", enum: [String(v.constant)] };
	});
	const fallback = typeof slot.default === "string" || typeof slot.default === "number" ? slot.default : undefined;
	const withDefault = fallback === undefined ? {} : { default: fallback };
	if (shapes.every((s) => s.enum)) {
		const enums = new Set(shapes.flatMap((s) => s.enum ?? []));
		if (typeof fallback === "string") enums.add(fallback);
		return { type: "string", enum: [...enums], ...withDefault };
	}
	return shapes.length === 1 ? { ...shapes[0], ...withDefault } : { anyOf: shapes, ...withDefault };
}

function shapeOf(slot: Slot): Shape {
	switch (slot.kind) {
		case "positional":
			return slot.schema;
		case "optional":
			return slot.value.schema;
		case "options":
			return optionsShape(slot);
		case "rest":
		case "passthrough":
		case "verbatim":
			return { type: "string" };
	}
}

export function slotSchema(slot: Slot): JsonSchema {
	return { ...shapeOf(slot), description: slot.about };
}

/** What the line cannot do without. */
export const isRequired = (slot: Slot): boolean => slot.kind === "positional" || endsLine(slot);

/** The agent tool's input schema. Advisory: `lineFromInput` checks every field itself. */
export function toolSchema(grammar: Grammar): JsonSchema {
	const entries = Object.entries(grammar);
	return {
		type: "object",
		properties: Object.fromEntries(entries.map(([key, slot]) => [key, slotSchema(slot)])),
		required: entries.filter(([, slot]) => isRequired(slot)).map(([k]) => k),
		additionalProperties: false,
	};
}

const WORD = /^(?!-)(?:\\[\\\s]|\S)+$/;

type Words = { readonly ok: true; readonly words: readonly string[] } | { readonly ok: false; readonly error: string };

function word(key: string, value: unknown, { quote = String }: Pick<Value<unknown>, "quote">): Words {
	const given = typeof value === "number" && Number.isFinite(value) ? String(value) : value;
	const text = typeof given === "string" ? quote(given) : given;
	if (typeof text === "string" && WORD.test(text)) return { ok: true, words: [text] };
	return { ok: false, error: `${key} must be one word that does not start with -, not ${JSON.stringify(value)}.` };
}

/** An example's value for the field, as it would be written in the tool's input. */
const such = (example: Example, key: string): string =>
	example[key] === undefined ? "" : `, such as ${JSON.stringify(example[key])}`;

function slotWords(key: string, slot: Slot, value: unknown): Words {
	switch (slot.kind) {
		case "positional":
			return word(key, value, slot);
		case "optional":
			return word(key, value, slot.value);
		case "options": {
			if (Object.is(value, slot.default)) return { ok: true, words: [] };
			const bare = slot.variants.find((v) => "constant" in v && Object.is(v.constant, value));
			if (bare) return { ok: true, words: [bare.flag] };
			const valued = slot.variants.find((v) => "value" in v);
			const options = slot.variants.map((v) => ("constant" in v ? JSON.stringify(v.constant) : v.flag));
			if (!valued) return { ok: false, error: `${key} must be one of ${options.join(", ")}.` };
			const w = word(key, value, valued.value);
			return w.ok ? { ok: true, words: [valued.flag, ...w.words] } : w;
		}
		case "rest": {
			if (typeof value !== "string") return { ok: false, error: `${key} must be a string.` };
			const words = value.split(/\s+/).filter((w) => w !== "");
			const flagLike = words.find((w) => w.startsWith("--"));
			if (flagLike) return { ok: false, error: `${key} cannot contain ${flagLike}.` };
			return { ok: true, words };
		}
		case "passthrough":
			if (typeof value !== "string" || /[\r\n]/.test(value)) {
				return { ok: false, error: `${key} must be a string on one line.` };
			}
			return { ok: true, words: ["--", value] };
		case "verbatim":
			if (typeof value !== "string") return { ok: false, error: `${key} must be a string.` };
			return { ok: true, words: ["--", value] };
	}
}

export function noField(tool: string, unknown: string, fields: readonly string[]): string {
	const why = `${tool} has no field called ${unknown}`;
	return fields.length === 0 ? `${why}, so leave it out.` : `${why}, so use ${list(fields, "or")}.`;
}

/**
 * An agent's tool input as a bar line. Each field becomes whole tokens, so a
 * field cannot smuggle extra arguments or options; the line then goes through
 * the same parser as anything typed.
 */
export function lineFromInput(verb: string, grammar: Grammar, input: unknown, example: Example): string | LineError {
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		return lineError(`${verb} wants its input as an object of fields, such as ${JSON.stringify(example)}.`);
	}
	const fields = new Map(Object.entries(input));
	const unknown = [...fields.keys()].find((k) => !(k in grammar));
	if (unknown !== undefined) return lineError(noField(verb, unknown, Object.keys(grammar)));

	const words = [verb];
	const tail: string[] = [];
	for (const [key, slot] of Object.entries(grammar)) {
		const value = fields.get(key);
		if (value === undefined) {
			if (isRequired(slot)) return lineError(`${verb} needs the ${key} field${such(example, key)}.`);
			continue;
		}
		const w = slotWords(key, slot, value);
		if (!w.ok) return lineError(w.error);
		(endsLine(slot) ? tail : words).push(...w.words);
	}
	return [...words, ...tail].join(" ");
}
