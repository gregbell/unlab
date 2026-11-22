import { type JsonSchema, type LineError, lineError } from "../types.ts";
import type { Grammar, Options, Slot } from "./slots.ts";

function optionsSchema(slot: Options<unknown>): JsonSchema {
	const shapes = slot.variants.map((v): JsonSchema => {
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

function slotSchema(slot: Slot): JsonSchema {
	switch (slot.kind) {
		case "positional":
			return slot.schema;
		case "options":
			return optionsSchema(slot);
		case "rest":
			return { type: "string", description: `The ${slot.label}, as typed after the verb in the command bar.` };
		case "passthrough":
			return { type: "string", description: `The ${slot.label}, passed on untouched.` };
	}
}

/** The agent tool's input schema. Advisory: `lineFromInput` checks every field itself. */
export function toolSchema(grammar: Grammar): JsonSchema {
	const entries = Object.entries(grammar);
	return {
		type: "object",
		properties: Object.fromEntries(entries.map(([key, slot]) => [key, slotSchema(slot)])),
		required: entries.filter(([, slot]) => slot.kind === "positional" || slot.kind === "passthrough").map(([k]) => k),
		additionalProperties: false,
	};
}

const WORD = /^[^\s-]\S*$/;

type Words = { readonly ok: true; readonly words: readonly string[] } | { readonly ok: false; readonly error: string };

function word(key: string, value: unknown): Words {
	const text = typeof value === "number" && Number.isFinite(value) ? String(value) : value;
	if (typeof text === "string" && WORD.test(text)) return { ok: true, words: [text] };
	return { ok: false, error: `${key} must be one word that does not start with -, not ${JSON.stringify(value)}.` };
}

function slotWords(key: string, slot: Slot, value: unknown): Words {
	switch (slot.kind) {
		case "positional":
			return word(key, value);
		case "options": {
			if (Object.is(value, slot.default)) return { ok: true, words: [] };
			const bare = slot.variants.find((v) => "constant" in v && Object.is(v.constant, value));
			if (bare) return { ok: true, words: [bare.flag] };
			const valued = slot.variants.find((v) => "value" in v);
			const options = slot.variants.map((v) => ("constant" in v ? JSON.stringify(v.constant) : v.flag));
			if (!valued) return { ok: false, error: `${key} must be one of ${options.join(", ")}.` };
			const w = word(key, value);
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
	}
}

/**
 * An agent's tool input as a bar line. Each field becomes whole tokens, so a
 * field cannot smuggle extra arguments or options; the line then goes through
 * the same parser as anything typed.
 */
export function lineFromInput(verb: string, grammar: Grammar, input: unknown): string | LineError {
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		return lineError(`${verb} wants its input as an object of fields.`);
	}
	const fields = new Map(Object.entries(input));
	const unknown = [...fields.keys()].find((k) => !(k in grammar));
	if (unknown !== undefined) return lineError(`${verb} has no field called ${unknown}.`);

	const words = [verb];
	const tail: string[] = [];
	for (const [key, slot] of Object.entries(grammar)) {
		const value = fields.get(key);
		if (value === undefined) {
			if (slot.kind === "positional" || slot.kind === "passthrough")
				return lineError(`${verb} needs the ${key} field.`);
			continue;
		}
		const w = slotWords(key, slot, value);
		if (!w.ok) return lineError(w.error);
		(slot.kind === "passthrough" ? tail : words).push(...w.words);
	}
	return [...words, ...tail].join(" ");
}
