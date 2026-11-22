import type { LabState, Machine, MachineName, Phase, SessionId } from "../../model/types.ts";
import type { JsonSchema, Suggestion } from "../types.ts";

export interface ReadContext {
	readonly verb: string;
	readonly lab: LabState;
	/** The lifecycle phases this verb acts on. Machines in other phases are skipped or refused. */
	readonly phases: readonly Phase[];
}

/**
 * A token that does not fit. Without a message the engine says
 * `<verb> wants <noun> here, not <token>.` `part` narrows the fix to a span
 * of the token, such as one name in `node1,nodx`. A token that names
 * something real in the wrong state is not a typo, so it is not `fixable`.
 */
export class Miss {
	constructor(
		readonly message?: string,
		readonly part?: { readonly start: number; readonly end: number },
		readonly fixable = true,
	) {}
}

/** One token's worth of typed value. Used directly as a positional slot, or after an option flag. */
export interface Value<T> {
	readonly kind: "positional";
	/** In the signature: `count`, `up | down`, `machines`. */
	readonly label: string;
	/** In sentences: `a count`, `up or down`. */
	readonly noun: string;
	read(text: string, ctx: ReadContext): T | Miss;
	/** Full-token inserts for what is typed so far; the engine filters them by prefix. */
	suggest(typed: string, ctx: ReadContext): readonly Suggestion[];
	format(value: T): string;
	readonly schema: JsonSchema;
}

export type Flag = `--${string}`;

export type Variant<T> =
	| { readonly flag: Flag; readonly value: Value<T> }
	| { readonly flag: Flag; readonly constant: T };

/** Mutually exclusive flags filling one argument, with the value used when all are left out. */
export interface Options<T> {
	readonly kind: "options";
	readonly variants: readonly Variant<T>[];
	readonly default: T;
}

/** The remaining plain tokens, joined by single spaces. */
export interface Rest {
	readonly kind: "rest";
	readonly label: string;
}

/** Everything after a bare `--`. */
export interface Passthrough {
	readonly kind: "passthrough";
	readonly label: string;
}

export type Slot = Value<unknown> | Options<unknown> | Rest | Passthrough;
export type Grammar = Readonly<Record<string, Slot>>;

type SlotValue<S> = S extends Value<infer T> ? T : S extends Options<infer T> ? T : string;
export type ArgsOf<G extends Grammar> = { readonly [K in keyof G]: SlotValue<G[K]> };

/** A machines argument as typed, expanded against the lab when it was read. */
export interface Selection {
	readonly machines: readonly MachineName[];
	readonly skipped: readonly { readonly name: MachineName; readonly reason: string }[];
	readonly written: string;
}

const PHASE_WORDS: Readonly<Record<Phase, { readonly skipped: string; readonly sentence: string }>> = {
	booting: { skipped: "still booting", sentence: "is still booting" },
	ready: { skipped: "already running", sentence: "is already running" },
	failed: { skipped: "did not boot", sentence: "did not boot" },
	removing: { skipped: "being removed", sentence: "is being removed" },
};

function list(words: readonly string[], conjunction: string): string {
	if (words.length < 2) return words.join("");
	return `${words.slice(0, -1).join(", ")} ${conjunction} ${words[words.length - 1]}`;
}

function machinesOf(lab: LabState): readonly Machine[] {
	return lab.rail.flatMap((name) => lab.machines[name] ?? []);
}

function findMachine(lab: LabState, text: string): Machine | undefined {
	return machinesOf(lab).find((m) => m.name === text);
}

function youHave(lab: LabState): string {
	const names = lab.rail;
	return names.length === 0 ? "The lab has no machines yet." : `You have ${names.join(", ")}.`;
}

function noMachine(lab: LabState, text: string): string {
	return `No machine called ${text}. ${youHave(lab)}`;
}

function phaseNoun(phases: readonly Phase[]): string {
	return phases.length === 1 ? `a ${phases[0]} machine` : "a machine";
}

function linkWord(m: Machine): string {
	if (m.life.phase !== "ready") return m.life.phase;
	if (m.life.plug.kind === "none") return "no cable";
	return m.life.plug.link === "up" ? "up" : "down";
}

function machineSuggestion(m: Machine, insert: string = m.name): Suggestion {
	return { insert, label: m.name, detail: `${m.ip} · ${linkWord(m)}`, hue: m.hue };
}

function allowed(m: Machine, ctx: ReadContext): boolean {
	return ctx.phases.includes(m.life.phase);
}

function readMachine(text: string, ctx: ReadContext): Machine | Miss {
	const m = findMachine(ctx.lab, text);
	if (!m) return new Miss(noMachine(ctx.lab, text));
	if (!allowed(m, ctx)) {
		const why = `${ctx.verb} wants ${phaseNoun(ctx.phases)} here, and ${m.name} ${PHASE_WORDS[m.life.phase].sentence}.`;
		return new Miss(why, undefined, false);
	}
	return m;
}

const POSITIVE_INTEGER = /^[1-9][0-9]*$/;

export function count(
	opts: { label?: string; noun?: string; suggest?: (lab: LabState) => readonly number[] } = {},
): Value<number> {
	return {
		kind: "positional",
		label: opts.label ?? "count",
		noun: opts.noun ?? "a count",
		read(text) {
			const n = Number(text);
			return POSITIVE_INTEGER.test(text) && Number.isSafeInteger(n) ? n : new Miss();
		},
		suggest(_typed, ctx) {
			return (opts.suggest?.(ctx.lab) ?? []).map((n) => ({ insert: String(n), label: String(n) }));
		},
		format: String,
		schema: { type: "integer", minimum: 1 },
	};
}

export function choice<const C extends string>(choices: readonly C[]): Value<C> {
	return {
		kind: "positional",
		label: choices.join(" | "),
		noun: list(choices, "or"),
		read(text) {
			return choices.find((c) => c === text) ?? new Miss();
		},
		suggest() {
			return choices.map((c) => ({ insert: c, label: c }));
		},
		format: (c) => c,
		schema: { type: "string", enum: choices },
	};
}

export function image(): Value<string> {
	return {
		kind: "positional",
		label: "image",
		noun: "an image",
		read(text, { lab }) {
			if (lab.images.some((i) => i.name === text)) return text;
			const names = lab.images.map((i) => i.name);
			const have = names.length === 0 ? "No images are available." : `You have ${names.join(", ")}.`;
			return new Miss(`No image called ${text}. ${have}`);
		},
		suggest(_typed, { lab }) {
			return lab.images.map((i) => ({ insert: i.name, label: i.name, detail: i.label }));
		},
		format: (name) => name,
		schema: { type: "string", description: "An image name from the lab's manifest, such as alpine." },
	};
}

export function machine(): Value<MachineName> {
	return {
		kind: "positional",
		label: "machine",
		noun: "a machine",
		read(text, ctx) {
			const m = readMachine(text, ctx);
			return m instanceof Miss ? m : m.name;
		},
		suggest(_typed, ctx) {
			return machinesOf(ctx.lab)
				.filter((m) => allowed(m, ctx))
				.map((m) => machineSuggestion(m));
		},
		format: (name) => name,
		schema: { type: "string", description: "A machine name, such as node2." },
	};
}

/** A machine (its active session) or one session: `node2`, `node2:sh1`. */
export function target(): Value<MachineName | SessionId> {
	return {
		kind: "positional",
		label: "machine or session",
		noun: "a machine or session",
		read(text, ctx) {
			const colon = text.indexOf(":");
			const m = readMachine(colon < 0 ? text : text.slice(0, colon), ctx);
			if (m instanceof Miss) return colon < 0 ? m : new Miss(m.message, { start: 0, end: colon }, m.fixable);
			if (colon < 0) return m.name;
			const session = m.sessions.find((s) => s === text);
			if (session) return session;
			const has = m.sessions.map((s) => s.slice(m.name.length + 1));
			return new Miss(`${m.name} has no session called ${text.slice(colon + 1)}. It has ${has.join(", ")}.`);
		},
		suggest(_typed, ctx) {
			return machinesOf(ctx.lab)
				.filter((m) => allowed(m, ctx))
				.flatMap((m) => [
					machineSuggestion(m),
					...m.sessions.map((s) => ({
						insert: s,
						label: s,
						detail: s.endsWith(":console") ? "console" : "shell",
						hue: m.hue,
					})),
				]);
		},
		format: (t) => t,
		schema: {
			type: "string",
			description: "A machine name (node2) for its active session, or one session (node2:sh1).",
		},
	};
}

function globPattern(glob: string): RegExp {
	const escaped = glob.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
	return new RegExp(`^${escaped.join(".*")}$`);
}

/**
 * `node2`, `node1,node3`, `node*` or `all`. Expands to the machines in the
 * verb's phases and records the rest as skipped, so `link down all` acts on
 * ready machines and says `skipped node4: still booting`.
 */
export function machines(): Value<Selection> {
	return {
		kind: "positional",
		label: "machines",
		noun: "machines",
		read(text, ctx) {
			const picked: MachineName[] = [];
			const skipped: { name: MachineName; reason: string }[] = [];
			let start = 0;
			for (const part of text.split(",")) {
				const span = { start, end: start + part.length };
				start = span.end + 1;
				if (part === "") return new Miss(undefined, span);
				const all = machinesOf(ctx.lab);
				let matched: readonly Machine[];
				if (part === "all") {
					matched = all;
				} else if (part.includes("*")) {
					const pattern = globPattern(part);
					matched = all.filter((m) => pattern.test(m.name));
					if (matched.length === 0) return new Miss(`No machine matches ${part}. ${youHave(ctx.lab)}`, span);
				} else {
					const m = findMachine(ctx.lab, part);
					if (!m) return new Miss(noMachine(ctx.lab, part), span);
					matched = [m];
				}
				for (const m of matched) {
					if (allowed(m, ctx)) {
						if (!picked.includes(m.name)) picked.push(m.name);
					} else if (!skipped.some((s) => s.name === m.name)) {
						skipped.push({ name: m.name, reason: PHASE_WORDS[m.life.phase].skipped });
					}
				}
			}
			if (picked.length === 0) {
				const why =
					skipped.length === 0
						? youHave(ctx.lab)
						: `Skipped ${skipped.map((s) => `${s.name}: ${s.reason}`).join("; ")}.`;
				return new Miss(`${ctx.verb} has no machine to act on. ${why}`, undefined, false);
			}
			return { machines: picked, skipped, written: text };
		},
		suggest(typed, ctx) {
			const comma = typed.lastIndexOf(",");
			const head = comma < 0 ? "" : typed.slice(0, comma + 1);
			const listed = head.split(",");
			const names = machinesOf(ctx.lab)
				.filter((m) => allowed(m, ctx) && !listed.includes(m.name))
				.map((m) => machineSuggestion(m, head + m.name));
			return head === ""
				? [...names, { insert: "all", label: "all", detail: "every machine that can take it" }]
				: names;
		},
		format: (s) => s.written,
		schema: {
			type: "string",
			description: "One machine (node2), a comma list (node1,node3), a glob (node*) or all.",
		},
	};
}

export function option<T>(flag: Flag, value: Value<T>, defaultValue: T): Options<T> {
	return { kind: "options", variants: [{ flag, value }], default: defaultValue };
}

export function valued<T>(flag: Flag, value: Value<T>): Variant<T> {
	return { flag, value };
}

export function flag<const T>(flag: Flag, constant: T): Variant<T> {
	return { flag, constant };
}

/** `--net switch0 | --no-net`. At most one variant takes a value, so a value always formats one way. */
export function exclusive<T>(defaultValue: T, variants: readonly Variant<T>[]): Options<T> {
	if (variants.filter((v) => "value" in v).length > 1) {
		throw new Error(`exclusive(${variants.map((v) => v.flag).join(", ")}): at most one variant may take a value`);
	}
	return { kind: "options", variants, default: defaultValue };
}

export function text(label: string): Rest {
	return { kind: "rest", label };
}

export function passthrough(label: string): Passthrough {
	return { kind: "passthrough", label };
}
