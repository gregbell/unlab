import {
	type Address,
	ALL_MACHINES,
	addressText,
	type CheckpointName,
	DEFAULT_SWITCH,
	type GiB,
	heldPorts,
	isNameFault,
	type LabState,
	lowestFreePorts,
	MAX_EXTRA_DISKS,
	MAX_EXTRA_GIB,
	MAX_NAME,
	type Machine,
	type MachineName,
	machineLink,
	type NameFault,
	type NicRef,
	type NicSpec,
	nicLabel,
	nicsOf,
	type Phase,
	type Place,
	PORTS,
	type PortNo,
	parseCheckpointName,
	parseChosenName,
	parseGiB,
	parseSwitchName,
	plugsOf,
	portLabel,
	portName,
	type SessionId,
	type SwitchName,
	selectNames,
	sizeText,
	takenPorts,
} from "../../model/index.ts";
import {
	type AddressFault,
	addressStr,
	compileFilter,
	FILTER_PROTOCOLS,
	ip4str,
	isAddressFault,
	NICS,
	type NicNo,
	nicName,
	PORT_WORD,
	parseAddress,
	parseNicName,
} from "../../net/index.ts";
import type { JsonSchema, Suggestion } from "../types.ts";
import { globMatch } from "./glob.ts";

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
	/** In sentences: `a count such as 2`, `up or down`. */
	readonly noun: string;
	/** What help and the tool's schema say it is. */
	readonly about: string;
	read(text: string, ctx: ReadContext): T | Miss;
	/** Full-token inserts for what is typed so far; the engine filters them by prefix. */
	suggest(typed: string, ctx: ReadContext): readonly Suggestion[];
	format(value: T): string;
	/** How a tool's text is written as one word. Left out, it has to be one. */
	quote?(text: string): string;
	readonly schema: Omit<JsonSchema, "description">;
}

/** A value that can be left out, with nothing after it. Null is what left out says. */
export interface Optional<T> {
	readonly kind: "optional";
	readonly about: string;
	readonly value: Value<T>;
}

export type Flag = `--${string}`;

export type Variant<T> =
	| { readonly flag: Flag; readonly value: Value<T> }
	| { readonly flag: Flag; readonly constant: T };

/** Mutually exclusive flags filling one argument, with the value used when all are left out. */
export interface Options<T> {
	readonly kind: "options";
	readonly about: string;
	readonly variants: readonly Variant<T>[];
	readonly default: T;
}

/** Why words cannot be read: the one at fault by its place in them, and what it could have been instead. */
export interface WordsFault {
	readonly message: string;
	readonly start: number;
	readonly instead: readonly string[];
}

/** The remaining plain tokens, joined by single spaces. */
export interface Rest {
	readonly kind: "rest";
	readonly label: string;
	readonly about: string;
	/** Left out, any words are read. */
	check?(text: string, ctx: ReadContext): WordsFault | null;
	/** For the word under the caret, as a value's. Left out, none. */
	suggest?(typed: string, ctx: ReadContext): readonly Suggestion[];
}

/** Everything after a bare `--`. */
export interface Passthrough {
	readonly kind: "passthrough";
	readonly label: string;
	readonly about: string;
}

/** Everything after a bare `--` and one space, whatever it is, and it can be nothing. */
export interface Verbatim {
	readonly kind: "verbatim";
	readonly label: string;
	readonly about: string;
}

export type Slot = Value<unknown> | Optional<unknown> | Options<unknown> | Rest | Passthrough | Verbatim;
export type Grammar = Readonly<Record<string, Slot>>;

type SlotValue<S> =
	S extends Value<infer T> ? T : S extends Optional<infer T> ? T | null : S extends Options<infer T> ? T : string;
export type ArgsOf<G extends Grammar> = { readonly [K in keyof G]: SlotValue<G[K]> };

/** A machines argument as typed, expanded against the lab when it was read. */
export interface Selection {
	readonly machines: readonly MachineName[];
	readonly skipped: readonly { readonly name: MachineName; readonly reason: string }[];
	readonly written: string;
}

/** Cables as typed, expanded to the NICs they are plugged into. */
export interface CableSelection {
	readonly nics: readonly NicRef[];
	readonly skipped: Selection["skipped"];
	readonly written: string;
}

/** What a NIC can be plugged into. */
const networksOf = (lab: LabState): readonly NicSpec["net"][] => [...lab.switches, "none"];

/** One part of `--net`, unless it names a switch that is not there. */
export function readNetwork(text: string, lab: LabState): NicSpec["net"] | null {
	return networksOf(lab).find((network) => network === text) ?? null;
}

/** `part` is the one that is not there, whatever else the list names. */
export function noNetwork({ verb, lab }: Pick<ReadContext, "verb" | "lab">, part: string): string {
	return `${verb} wants ${list(networksOf(lab), "or")} after --net, not ${part || "nothing"}.`;
}

/** The state a machine is in, as a reason to leave it out. */
export const PHASE_REASON: Readonly<Record<Phase, string>> = {
	booting: "still booting",
	ready: "ready",
	stopping: "stopping",
	restoring: "being restored",
	off: "off",
	failed: "failed",
	removing: "being removed",
};

/** `node1 is still booting`, `node1 has failed`, `node1 has no eth3` */
export function because({ name, reason }: { readonly name: string; readonly reason: string }): string {
	return `${name} ${reason === "failed" ? "has failed" : reason.startsWith("no ") ? `has ${reason}` : `is ${reason}`}`;
}

export function list(words: readonly string[], conjunction: string): string {
	if (words.length < 2) return words.join("");
	return `${words.slice(0, -1).join(", ")} ${conjunction} ${words[words.length - 1]}`;
}

function machinesOf(lab: LabState): readonly Machine[] {
	return lab.rail.flatMap((name) => lab.machines[name] ?? []);
}

function findMachine(lab: LabState, text: string): Machine | undefined {
	return machinesOf(lab).find((m) => m.name === text);
}

/** What there is in place of what was named. */
function soUse(lab: LabState): string {
	return lab.rail.length === 0 ? "and the lab has none yet, so spawn one first" : `so use ${list(lab.rail, "or")}`;
}

export function noMachine(lab: LabState, text: string): string {
	return `No machine is called ${text}, ${soUse(lab)}.`;
}

export function noMatch(lab: LabState, glob: string): string {
	return `No machine matches ${glob}, ${soUse(lab)}.`;
}

function phaseNoun(phases: readonly Phase[]): string {
	if (phases.length > 3) return "a machine that is not being removed";
	return `${phases[0] === "off" ? "an" : "a"} ${list(phases, "or")} machine`;
}

function linkWord(m: Machine): string {
	switch (machineLink(m)) {
		case null:
			return m.life.phase;
		case "unplugged":
			return "no cable";
		case "up":
			return "up";
		case "cut":
			return "down";
	}
}

function plugDetail(lab: LabState, m: Machine, nic: NicNo): string {
	const plug = plugsOf(m.life)[nic];
	if (plug?.kind !== "port") return "no cable";
	return `${portLabel(lab, plug.port)} · ${plug.link === "up" ? "up" : "down"}`;
}

function machineSuggestion(m: Machine, insert: string = m.name): Suggestion {
	return { insert, label: m.name, detail: `${addressText(m)} · ${linkWord(m)}`, hue: m.hue };
}

function allowed(m: Machine, ctx: ReadContext): boolean {
	return ctx.phases.includes(m.life.phase);
}

/** Nothing that was named is in a state that the verb takes. */
export function wrongState(ctx: ReadContext, skipped: Selection["skipped"]): Miss {
	const why =
		skipped.length === 0
			? `The lab has no machine for ${ctx.verb} yet, so spawn one first.`
			: `${ctx.verb} wants ${phaseNoun(ctx.phases)} here, and ${list(skipped.map(because), "and")}.`;
	return new Miss(why, undefined, false);
}

export function readMachine(text: string, ctx: ReadContext): Machine | Miss {
	const m = findMachine(ctx.lab, text);
	if (!m) return new Miss(noMachine(ctx.lab, text));
	return allowed(m, ctx) ? m : wrongState(ctx, [{ name: m.name, reason: PHASE_REASON[m.life.phase] }]);
}

const POSITIVE_INTEGER = /^[1-9][0-9]*$/;

export function count(
	about: string,
	opts: { label?: string; noun?: string; suggest?: (lab: LabState) => readonly number[] } = {},
): Value<number> {
	return {
		kind: "positional",
		label: opts.label ?? "count",
		noun: opts.noun ?? "a count such as 2",
		about,
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

export function choice<const C extends string>(about: string, choices: readonly C[]): Value<C> {
	return {
		kind: "positional",
		label: choices.join(" | "),
		noun: list(choices, "or"),
		about,
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

export function noImage(lab: LabState, text: string): string {
	const names = lab.images.map((i) => i.name);
	const why = `No image is called ${text}`;
	return names.length === 0 ? `${why}, and the lab has none.` : `${why}, so use ${list(names, "or")}.`;
}

export function image(): Value<string> {
	return {
		kind: "positional",
		label: "image",
		noun: "an image such as alpine",
		about:
			"alpine, debian or lab: Alpine with iproute2, tcpdump, curl, dig, ssh, nginx, strace, sfdisk and mkfs installed, for use offline.",
		read(text, { lab }) {
			if (lab.images.some((i) => i.name === text)) return text;
			return new Miss(noImage(lab, text));
		},
		suggest(_typed, { lab }) {
			return lab.images.map((i) => ({ insert: i.name, label: i.name, detail: i.label }));
		},
		format: (name) => name,
		schema: { type: "string" },
	};
}

export function machine(): Value<MachineName> {
	return {
		kind: "positional",
		label: "machine",
		noun: "a machine such as node2",
		about: "A machine name, such as node2.",
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
		schema: { type: "string" },
	};
}

/** `wants` is what asks for the name, and `such` one that would do. */
function nameFault(text: string, fault: NameFault, wants: string, such: string): string {
	switch (fault.kind) {
		case "unreadable": {
			const lower = text.toLowerCase();
			const reads = !isNameFault(parseChosenName(lower));
			return reads
				? `${wants} wants lowercase letters, so use ${lower}.`
				: `${wants} wants lowercase letters, digits and hyphens, starting with a letter and not ending with a hyphen, such as ${such}, not ${text}.`;
		}
		case "too-long":
			return `${wants} wants at most ${MAX_NAME} characters, and that is ${fault.length}.`;
		case "lab":
			return `The lab gives out ${text} itself, so use another name, such as ${such}.`;
		case "word":
			return `${text} already means something in the lab, so use another name, such as ${text}-1.`;
	}
}

/** A name for a machine that is not there yet. Null is what no option says: `node<n>`. */
export function newName(): Value<MachineName | null> {
	return {
		kind: "positional",
		label: "name",
		noun: "a name such as web-1",
		about:
			"The machine's name and hostname: lowercase letters, digits and hyphens, such as web-1. Left out, node and a number. Needs count 1.",
		read(text) {
			const name = parseChosenName(text);
			return isNameFault(name) ? new Miss(nameFault(text, name, "--name", "web-1"), undefined, false) : name;
		},
		suggest: () => [],
		format: String,
		schema: { type: "string" },
	};
}

/** A name for a switch that is not there yet. Whether it is free is the verb's to say. */
export function newSwitch(): Value<SwitchName> {
	return {
		kind: "positional",
		label: "name",
		noun: "a name for the switch such as lan",
		about:
			"The switch's name, which no machine or switch has: lowercase letters, digits and hyphens, such as lan. Left out, switch and a number.",
		read(text, { verb }) {
			const name = parseSwitchName(text);
			return isNameFault(name) ? new Miss(nameFault(text, name, verb, "lan"), undefined, false) : name;
		},
		suggest: () => [],
		format: (name) => name,
		schema: { type: "string" },
	};
}

/** The switch, unless it is not there or is the one that every lab has. */
export function readAddedSwitch(text: string, { switches }: LabState): SwitchName | Miss {
	const others = switches.filter((name) => name !== DEFAULT_SWITCH);
	const found = others.find((name) => name === text);
	if (found) return found;
	const instead = others.length === 0 ? "and the lab has no other switch" : `so use ${list(others, "or")}`;
	return text === DEFAULT_SWITCH
		? new Miss(`${DEFAULT_SWITCH} cannot be removed, ${instead}.`, undefined, false)
		: new Miss(
				others.length === 0
					? `No switch is called ${text}, and ${DEFAULT_SWITCH}, the only one, cannot be removed.`
					: `No switch is called ${text}, ${instead}.`,
			);
}

/** A switch that was added. */
export function addedSwitch(): Value<SwitchName> {
	return {
		kind: "positional",
		label: "switch",
		noun: "a switch such as lan",
		about: `A switch's name, such as lan. ${DEFAULT_SWITCH} stays.`,
		read: (text, { lab }) => readAddedSwitch(text, lab),
		suggest: (_typed, { lab }) =>
			lab.switches
				.filter((name) => name !== DEFAULT_SWITCH)
				.map((name) => ({
					insert: name,
					label: name,
					detail: portsTaken(lab, name),
				})),
		format: (name) => name,
		schema: { type: "string" },
	};
}

const CHECKPOINT = "A checkpoint's name: lowercase letters, digits and hyphens, such as before-upgrade.";

function readCheckpoint(text: string, { verb }: ReadContext): CheckpointName | Miss {
	const name = parseCheckpointName(text);
	if (name) return name;
	const lower = parseCheckpointName(text.toLowerCase());
	const why = lower
		? `A checkpoint's name is in lowercase letters, so use ${lower}.`
		: text.length > MAX_NAME
			? `A checkpoint's name has at most ${MAX_NAME} characters, and that is ${text.length}.`
			: `${verb} wants a name of lowercase letters, digits and hyphens, starting with a letter and not ending with a hyphen, such as before-upgrade, not ${text}.`;
	return new Miss(why, undefined, false);
}

/** A name for a checkpoint that is not there yet. Whether the machine has one of that name is the verb's to say. */
export function newCheckpoint(): Value<CheckpointName> {
	return {
		kind: "positional",
		label: "checkpoint",
		noun: "a name for the checkpoint such as before-upgrade",
		about: CHECKPOINT,
		read: readCheckpoint,
		suggest: () => [],
		format: (name) => name,
		schema: { type: "string" },
	};
}

/** The name of a checkpoint that is there. Whether it is the machine's is the verb's to say. */
export function checkpoint(): Value<CheckpointName> {
	return {
		kind: "positional",
		label: "checkpoint",
		noun: "a checkpoint such as before-upgrade",
		about: CHECKPOINT,
		read: readCheckpoint,
		suggest: (_typed, { lab }) =>
			machinesOf(lab).flatMap((m) =>
				m.sets.checkpoints.map(
					({ name, bytes }): Suggestion => ({
						insert: name,
						label: name,
						detail: `${m.name} · ${sizeText(bytes)}`,
						hue: m.hue,
					}),
				),
			),
		format: (name) => name,
		schema: { type: "string" },
	};
}

const MAX_PATH = 4095;
/** The last number is for no one, and a guest would wrap what is over it round to another's. */
const MAX_ID = 2 ** 32 - 2;

/** A space is written `\ `, and a backslash `\\`, as a shell would. */
const quotePath = (path: string): string => path.replace(/[\\\s]/g, "\\$&");

function pathFault(path: string, verb: string): string | null {
	if (!path.startsWith("/")) return `${verb} wants a path that starts with /, such as /etc/motd, not ${path}.`;
	if (/[\p{Cc}\p{Cs}]/u.test(path)) return `${verb} wants a path with no control characters.`;
	if (path.endsWith("/")) return `${path} names a directory, so give the path of a file in it, such as ${path}motd.`;
	if (path.split("/").some((part) => part === "." || part === "..")) {
		return `${path} has a part that is only dots, so give the path without it.`;
	}
	const bytes = new TextEncoder().encode(path).length;
	return bytes > MAX_PATH ? `A path has at most ${MAX_PATH} bytes, and that is ${bytes}.` : null;
}

/** Where a file goes in a guest, from its root. */
export function filePath(): Value<string> {
	return {
		kind: "positional",
		label: "path",
		noun: "a path such as /etc/motd",
		about: "The file's path from /, such as /etc/motd. Directories on the way that are missing are made.",
		read(text, { verb }) {
			const path = text.replace(/\\([\\\s])/g, "$1");
			const fault = pathFault(path, verb);
			return fault === null ? path.replace(/\/+/g, "/") : new Miss(fault, undefined, false);
		},
		suggest: () => [],
		format: quotePath,
		quote: quotePath,
		schema: { type: "string" },
	};
}

/** Null is what no option says: a file that is there keeps its owner, and a new one is root's. */
export function owner(): Value<string | null> {
	return {
		kind: "positional",
		label: "user[:group]",
		noun: "a user such as root, or user:group",
		about:
			"Its user, or user:group. A user alone brings their own group. Left out, a file keeps its owner, and a new one is root's.",
		read(text) {
			const accounts = text.split(":");
			const read = accounts.every((name) => /^\w[\w.-]*$/.test(name) && !(Number(name) > MAX_ID));
			if (read && accounts.length <= 2) return text;
			const why = `--owner wants a user or user:group, such as root or www-data:adm, not ${text}.`;
			return new Miss(why, undefined, false);
		},
		suggest: () => ["root", "user"].map((name) => ({ insert: name, label: name })),
		format: String,
		schema: { type: "string" },
	};
}

/** Null is what no option says: a file that is there keeps its mode, and a new one has 644. */
export function fileMode(): Value<string | null> {
	return {
		kind: "positional",
		label: "mode",
		noun: "a mode such as 644",
		about: "Its mode in octal, such as 600 or 755. Left out, a file keeps its mode, and a new one has 644.",
		read(text) {
			if (/^[0-7]{3,4}$/.test(text)) return text;
			return new Miss(`--mode wants three or four octal digits, such as 644, not ${text}.`, undefined, false);
		},
		suggest: () => ["644", "600", "755"].map((mode) => ({ insert: mode, label: mode })),
		format: String,
		schema: { type: "string" },
	};
}

/** A machine (its active session) or one session: `node2`, `node2:sh1`. */
export function target(): Value<MachineName | SessionId> {
	return {
		kind: "positional",
		label: "machine or session",
		noun: "a machine or session such as node2 or node2:sh1",
		about: "A machine name (node2) for its active session, or one session (node2:sh1).",
		read(text, ctx) {
			const colon = text.indexOf(":");
			const m = readMachine(colon < 0 ? text : text.slice(0, colon), ctx);
			if (m instanceof Miss) return colon < 0 ? m : new Miss(m.message, { start: 0, end: colon }, m.fixable);
			if (colon < 0) return m.name;
			const session = m.sessions.find((s) => s === text);
			if (session) return session;
			const has = m.sessions.map((s) => s.slice(m.name.length + 1));
			return new Miss(`${m.name} has no session called ${text.slice(colon + 1)}, so use ${list(has, "or")}.`);
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
		schema: { type: "string" },
	};
}

/** The machines one part of a comma list names: `node2`, `node*` or `all`. */
function matchMachines(lab: LabState, part: string, span: Miss["part"]): readonly Machine[] | Miss {
	const all = machinesOf(lab);
	if (part === ALL_MACHINES) return all;
	if (part.includes("*")) {
		const matched = all.filter((m) => globMatch(part, m.name));
		return matched.length > 0 ? matched : new Miss(noMatch(lab, part), span);
	}
	const m = findMachine(lab, part);
	return m ? [m] : new Miss(noMachine(lab, part), span);
}

/** Each part of a comma list, with where it sits in the token. */
function listParts(text: string): readonly { readonly part: string; readonly start: number; readonly end: number }[] {
	let start = 0;
	return text.split(",").map((part) => {
		const at = { part, start, end: start + part.length };
		start = at.end + 1;
		return at;
	});
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
		noun: "machines such as node1,node3 or all",
		about: "One machine (node2), a comma list (node1,node3), a glob (node*) or all.",
		read(text, ctx) {
			const picked: MachineName[] = [];
			const skipped: { name: MachineName; reason: string }[] = [];
			for (const { part, ...span } of listParts(text)) {
				if (part === "") return new Miss(undefined, span);
				const matched = matchMachines(ctx.lab, part, span);
				if (matched instanceof Miss) return matched;
				for (const m of matched) {
					if (allowed(m, ctx)) {
						if (!picked.includes(m.name)) picked.push(m.name);
					} else if (!skipped.some((s) => s.name === m.name)) {
						skipped.push({ name: m.name, reason: PHASE_REASON[m.life.phase] });
					}
				}
			}
			if (picked.length === 0) return wrongState(ctx, skipped);
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
				? [...names, { insert: ALL_MACHINES, label: ALL_MACHINES, detail: "every machine that can take it" }]
				: names;
		},
		format: (s) => s.written,
		schema: { type: "string" },
	};
}

/**
 * Cables, named by the machine or by one of its NICs: `node2`, `node2:eth1`,
 * and the lists, globs and `all` that `machines` takes. A machine alone is
 * every NIC it has.
 */
export function cables(): Value<CableSelection> {
	return {
		kind: "positional",
		label: "machines",
		noun: "machines such as node1,node3:eth1 or all",
		about:
			"One machine (node2) for all its cables, one NIC (node2:eth1), a comma list (node1,node3:eth1), a glob (node*) or all.",
		read(text, ctx) {
			const picked = new Map<string, NicRef>();
			const skipped: { name: MachineName; reason: string }[] = [];
			const skip = (name: MachineName, reason: string) => {
				if (!skipped.some((s) => s.name === name)) skipped.push({ name, reason });
			};
			for (const { part, start, end } of listParts(text)) {
				const colon = part.indexOf(":");
				const named = colon < 0 ? part : part.slice(0, colon);
				const asked = colon < 0 ? null : part.slice(colon + 1);
				if (named === "" || asked === "") return new Miss(undefined, { start, end });
				const matched = matchMachines(ctx.lab, named, { start, end: start + named.length });
				if (matched instanceof Miss) return matched;
				const nic = asked === null ? null : parseNicName(asked);
				if (asked !== null && nic === null && named !== matched[0]?.name) {
					return new Miss(`No NIC is called ${asked}, so use ${list(NICS.map(nicName), "or")}.`, { start, end }, false);
				}
				for (const m of matched) {
					const has = nicsOf(ctx.lab, m.name);
					const refs = asked === null ? has : has.filter((ref) => ref.nic === nic);
					if (!allowed(m, ctx)) {
						skip(m.name, PHASE_REASON[m.life.phase]);
					} else if (refs.length > 0) {
						for (const ref of refs) picked.set(`${ref.machine}:${ref.nic}`, ref);
					} else if (named === m.name) {
						return new Miss(noNic(m.name, String(asked), has), { start, end }, false);
					} else {
						skip(m.name, `no ${asked}`);
					}
				}
			}
			if (picked.size === 0) return wrongState(ctx, skipped);
			return { nics: [...picked.values()], skipped, written: text };
		},
		suggest(typed, ctx) {
			const comma = typed.lastIndexOf(",");
			const head = comma < 0 ? "" : typed.slice(0, comma + 1);
			const listed = head.split(",");
			const names = machinesOf(ctx.lab)
				.filter((m) => allowed(m, ctx) && !listed.includes(m.name))
				.flatMap((m) => {
					const nics = nicsOf(ctx.lab, m.name);
					return [
						machineSuggestion(m, head + m.name),
						...(nics.length > 1 ? nics : []).map(({ nic }): Suggestion => {
							const label = `${m.name}:${nicName(nic)}`;
							return { insert: head + label, label, detail: plugDetail(ctx.lab, m, nic), hue: m.hue };
						}),
					];
				});
			return head === ""
				? [...names, { insert: ALL_MACHINES, label: ALL_MACHINES, detail: "every machine that can take it" }]
				: names;
		},
		format: (s) => s.written,
		schema: { type: "string" },
	};
}

/** One NIC, named by itself or by a machine that has no other. */
export function readNic(text: string, ctx: ReadContext): { readonly machine: Machine; readonly nic: NicNo } | Miss {
	if (text === ALL_MACHINES || /[*,]/.test(text)) {
		return new Miss(`${ctx.verb} takes one NIC at a time, such as node2 or node2:eth1, not ${text}.`, undefined, false);
	}
	const colon = text.indexOf(":");
	const end = colon < 0 ? text.length : colon;
	const machine = readMachine(text.slice(0, end), ctx);
	if (machine instanceof Miss) return new Miss(machine.message, { start: 0, end }, machine.fixable);
	const has = nicsOf(ctx.lab, machine.name);
	if (colon < 0) {
		const [only, ...more] = has;
		if (more.length === 0) return { machine, nic: only.nic };
		const names = list(
			has.map(({ nic }) => `${machine.name}:${nicName(nic)}`),
			"or",
		);
		return new Miss(`${machine.name} has ${has.length} NICs, so use ${names}.`, undefined, false);
	}
	const asked = text.slice(colon + 1);
	const named = has.find(({ nic }) => nicName(nic) === asked);
	return named ? { machine, nic: named.nic } : new Miss(noNic(machine.name, asked, has), undefined, false);
}

function noNic(machine: MachineName, asked: string, has: readonly NicRef[]): string {
	const names = list(
		has.map(({ nic }) => nicName(nic)),
		"or",
	);
	return asked === ""
		? `${machine}: names no NIC, so use ${names}.`
		: `${machine} has no NIC called ${asked}, so use ${names}.`;
}

export function nic(): Value<string> {
	return {
		kind: "positional",
		label: "nic",
		noun: "a NIC such as node2:eth1, or a machine that has one",
		about: "A NIC (node2:eth1), or the name of a machine that has only one (node2).",
		read(text, ctx) {
			const read = readNic(text, ctx);
			return read instanceof Miss ? read : text;
		},
		suggest(_typed, ctx) {
			return machinesOf(ctx.lab)
				.filter((m) => allowed(m, ctx))
				.flatMap((m) =>
					nicsOf(ctx.lab, m.name).map(({ nic }, _at, { length }): Suggestion => {
						const insert = length === 1 ? m.name : `${m.name}:${nicName(nic)}`;
						return { insert, label: insert, detail: plugDetail(ctx.lab, m, nic), hue: m.hue };
					}),
				);
		},
		format: (written) => written,
		schema: { type: "string" },
	};
}

/** A switch, or one of its ports as `portName` writes it. */
export function readPlace(text: string, lab: LabState): Place | Miss {
	const colon = text.indexOf(":");
	const end = colon < 0 ? text.length : colon;
	const named = text.slice(0, end);
	const on = lab.switches.find((name) => name === named);
	if (!on) {
		const why =
			named === "none"
				? "none is no switch, so use unplug to take the cable out."
				: `${named === "" ? `${text} names no switch` : `No switch is called ${named}`}, so use ${list(lab.switches, "or")}.`;
		return new Miss(why, { start: 0, end }, named !== "none");
	}
	if (colon < 0) return { switch: on, port: null };
	const port = PORTS.find((no) => String(no) === text.slice(colon + 1));
	if (port) return { switch: on, port };
	const [first, last] = [PORTS[0], PORTS[PORTS.length - 1]].map((no) => portName({ switch: on, port: no }));
	return new Miss(`${text} is no port, so use one from ${first} to ${last}.`, undefined, false);
}

const portsTaken = (lab: LabState, on: SwitchName): string =>
	`${takenPorts(lab, on).size} of ${PORTS.length} ports taken`;

/** Where a cable goes. */
export function place(): Value<string> {
	return {
		kind: "positional",
		label: "switch[:port]",
		noun: "a switch or a port such as lan:3",
		about: "A switch (lan) for its lowest free port, or one of its ports (lan:3).",
		read(text, { lab }) {
			const read = readPlace(text, lab);
			return read instanceof Miss ? read : text;
		},
		suggest(typed, { lab }) {
			const on = lab.switches.find((name) => typed.startsWith(`${name}:`));
			if (!on) return lab.switches.map((name) => ({ insert: name, label: name, detail: portsTaken(lab, name) }));
			return lowestFreePorts(lab, on, PORTS.length).map((port) => {
				const insert = portName({ switch: on, port });
				return { insert, label: insert, detail: "free" };
			});
		},
		format: (written) => written,
		schema: { type: "string" },
	};
}

/** What each NIC is plugged into: one answer for all of them, or a comma list with one for each. */
export function networks(): Value<string> {
	return {
		kind: "positional",
		label: "network,...",
		noun: `a switch such as ${DEFAULT_SWITCH}, or none`,
		about: `A switch or none for every NIC, or a comma list with one for each, eth0 first, such as ${DEFAULT_SWITCH},none. A NIC with none boots unplugged.`,
		read(text, ctx) {
			for (const { part, ...span } of listParts(text)) {
				if (readNetwork(part, ctx.lab) === null) return new Miss(noNetwork(ctx, part), span);
			}
			return text;
		},
		suggest(typed, { lab }) {
			const head = typed.slice(0, typed.lastIndexOf(",") + 1);
			return networksOf(lab).map((network) => ({ insert: head + network, label: network }));
		},
		format: (written) => written,
		schema: { type: "string" },
	};
}

function addressFault(part: string, fault: AddressFault): string {
	switch (fault.kind) {
		case "unreadable":
			return `--addr wants an address with its prefix, such as 10.1.0.1/24, or none, not ${part || "nothing"}.`;
		case "prefix":
			return `--addr ${part} needs a prefix from 1 to 32, as in ${ip4str(fault.ip)}/24.`;
		case "reserved":
			return `--addr ${part} is not an address a NIC can have, so use one such as 10.1.0.1/24.`;
		case "network":
		case "broadcast": {
			const what = fault.kind === "network" ? "names its whole subnet" : "is its subnet's broadcast address";
			return `--addr ${part} ${what}, so use one from ${ip4str(fault.first)} to ${ip4str(fault.last)}.`;
		}
	}
}

/** The address of each NIC, eth0 first, or `none`. Null is what no option says: the lab's own choice. */
export function addresses(): Value<readonly (Address | null)[] | null> {
	return {
		kind: "positional",
		label: "address,...",
		noun: "addresses such as 10.1.0.1/24,none",
		about:
			"Each NIC's address, eth0 first, such as 10.1.0.1/24,none. none leaves it up without one. Left out, eth0 has one in 10.88.0.0/24. Needs count 1.",
		read(text) {
			const read: (Address | null)[] = [];
			for (const { part, ...span } of listParts(text)) {
				if (part === "none") {
					read.push(null);
					continue;
				}
				const address = parseAddress(part);
				if (isAddressFault(address)) return new Miss(addressFault(part, address), span, address.kind === "unreadable");
				read.push(address);
			}
			return read;
		},
		suggest(typed) {
			const head = typed.slice(0, typed.lastIndexOf(",") + 1);
			return [{ insert: `${head}none`, label: "none", detail: "up, with no address" }];
		},
		format: (list) => (list ?? []).map((address) => (address ? addressStr(address) : "none")).join(","),
		schema: { type: "string" },
	};
}

/** The size of each extra disk. Null is what no option says: none. */
export function diskSizes(): Value<readonly GiB[] | null> {
	return {
		kind: "positional",
		label: "GiB,...",
		noun: "sizes in GiB such as 1,4",
		about: `Blank disks to add, as whole GiB each, such as 1,4: up to ${MAX_EXTRA_DISKS}, of 1 to ${MAX_EXTRA_GIB}. They are /dev/wdc and on, with no file system.`,
		read(text) {
			const parts = listParts(text);
			const read: GiB[] = [];
			for (const { part, ...span } of parts) {
				const size = POSITIVE_INTEGER.test(part) ? parseGiB(Number(part)) : null;
				if (size === null) {
					const why = `--extra-disk wants whole GiB from 1 to ${MAX_EXTRA_GIB}, such as 1,4, not ${part || "nothing"}.`;
					return new Miss(why, span, false);
				}
				read.push(size);
			}
			if (read.length <= MAX_EXTRA_DISKS) return read;
			const most = `A machine has up to ${MAX_EXTRA_DISKS} extra disks, and --extra-disk names ${read.length}.`;
			return new Miss(most, undefined, false);
		},
		suggest(typed) {
			const head = typed.slice(0, typed.lastIndexOf(",") + 1);
			return [1, 4, 16].map((size) => ({ insert: `${head}${size}`, label: `${size} GiB` }));
		},
		format: (sizes) => (sizes ?? []).join(","),
		schema: { type: "string" },
	};
}

export function optional<T>(value: Value<T>): Optional<T> {
	return { kind: "optional", about: value.about, value };
}

export function option<T>(flag: Flag, value: Value<T>, defaultValue: T): Options<T> {
	return { kind: "options", about: value.about, variants: [{ flag, value }], default: defaultValue };
}

export function valued<T>(flag: Flag, value: Value<T>): Variant<T> {
	return { flag, value };
}

export function flag<const T>(flag: Flag, constant: T): Variant<T> {
	return { flag, constant };
}

/** `--net switch0 | --no-net`. At most one variant takes a value, so a value always formats one way. */
export function exclusive<T>(about: string, defaultValue: T, variants: readonly Variant<T>[]): Options<T> {
	if (variants.filter((v) => "value" in v).length > 1) {
		throw new Error(`exclusive(${variants.map((v) => v.flag).join(", ")}): at most one variant may take a value`);
	}
	return { kind: "options", about, variants, default: defaultValue };
}

export function text(label: string, about: string): Rest {
	return { kind: "rest", label, about };
}

/** What a port's cable goes to, and whether it is cut. */
function portDetail(lab: LabState, on: SwitchName, port: PortNo): string {
	const held = heldPorts(lab, on).find((other) => other.port === port);
	if (!held) return "no cable";
	const { machine, nic } = held;
	const plug = plugsOf(machine.life)[nic];
	return `${nicLabel(machine, nic)} · ${plug?.kind === "port" && plug.link === "cut" ? "down" : "up"}`;
}

/** The parts of one machine or switch that is typed as far as its colon, or else whatever can be named. */
function filterTerms(typed: string, lab: LabState): readonly Suggestion[] {
	if (typed.startsWith(`${PORT_WORD}:`)) {
		return PORTS.map((port) => ({ insert: `${PORT_WORD}:${port}`, label: `${PORT_WORD}:${port}` }));
	}
	const on = lab.switches.find((name) => typed.startsWith(`${name}:`));
	if (on) {
		return PORTS.map((port) => {
			const insert = portName({ switch: on, port });
			return { insert, label: insert, detail: portDetail(lab, on, port) };
		});
	}
	return [
		...machinesOf(lab).flatMap((m) => {
			const nics = nicsOf(lab, m.name);
			const inParts = nics.length > 1 || typed.startsWith(`${m.name}:`);
			return [
				machineSuggestion(m),
				...(inParts ? nics : []).map(({ nic }): Suggestion => {
					const label = `${m.name}:${nicName(nic)}`;
					return { insert: label, label, detail: plugDetail(lab, m, nic), hue: m.hue };
				}),
			];
		}),
		...(lab.switches.length === 1 ? [] : lab.switches).map((name) => ({
			insert: name,
			label: name,
			detail: portsTaken(lab, name),
		})),
		...FILTER_PROTOCOLS.map((name) => ({ insert: name, label: name })),
	];
}

/** Which captured frames to show. */
export function frameFilter(): Rest {
	return {
		...text(
			"filter",
			"Terms that all match, with or between alternatives: protocol, machine, NIC (node2:eth1), IP, MAC, switch (lan), cable (lan:3), port:N. Empty is all.",
		),
		check(text, { lab }) {
			const names = selectNames(lab);
			const compiled = compileFilter(text, names);
			if (compiled.ok) return null;
			const { message, start, token } = compiled.error;
			const colon = token.indexOf(":");
			const named = filterTerms("", lab).map(({ insert }) => insert);
			const words = colon < 0 ? named : named.map((name) => name + token.slice(colon));
			// A fix that is refused in its turn would offer this line back.
			const fits = (word: string) =>
				compileFilter(text.slice(0, start) + word + text.slice(start + token.length), names).ok;
			const instead = words.filter(fits);
			return { message: message.replace(/^Capture /, "capture "), start, instead };
		},
		suggest: (typed, { lab }) => filterTerms(typed, lab),
	};
}

export function passthrough(label: string, about: string): Passthrough {
	return { kind: "passthrough", label, about };
}

export function verbatim(label: string, about: string): Verbatim {
	return { kind: "verbatim", label, about };
}

/** The slot takes what follows `--`. */
export function endsLine(slot: Slot): slot is Passthrough | Verbatim {
	return slot.kind === "passthrough" || slot.kind === "verbatim";
}
