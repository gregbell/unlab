import {
	type Address,
	ALL_MACHINES,
	addressText,
	type CheckpointName,
	type GiB,
	isNameFault,
	type LabState,
	MAX_EXTRA_DISKS,
	MAX_EXTRA_GIB,
	MAX_NAME,
	type Machine,
	type MachineName,
	machineLink,
	type NameFault,
	type NicRef,
	type NicSpec,
	nicsOf,
	type Phase,
	parseCheckpointName,
	parseChosenName,
	parseGiB,
	plugsOf,
	type SessionId,
	sizeText,
} from "../../model/index.ts";
import {
	type AddressFault,
	addressStr,
	ip4str,
	isAddressFault,
	NICS,
	type NicNo,
	nicName,
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

/** The remaining plain tokens, joined by single spaces. */
export interface Rest {
	readonly kind: "rest";
	readonly label: string;
	readonly about: string;
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

const NETWORKS: readonly NicSpec["net"][] = ["switch0", "none"];

const PHASE_WORDS: Readonly<Record<Phase, { readonly skipped: string; readonly sentence: string }>> = {
	booting: { skipped: "still booting", sentence: "is still booting" },
	ready: { skipped: "already running", sentence: "is already running" },
	stopping: { skipped: "stopping", sentence: "is stopping" },
	restoring: { skipped: "being restored", sentence: "is being restored" },
	off: { skipped: "off", sentence: "is off" },
	failed: { skipped: "failed", sentence: "has failed" },
	removing: { skipped: "being removed", sentence: "is being removed" },
};

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

function youHave(lab: LabState): string {
	const names = lab.rail;
	return names.length === 0 ? "The lab has no machines yet." : `You have ${names.join(", ")}.`;
}

function noMachine(lab: LabState, text: string): string {
	return `No machine called ${text}. ${youHave(lab)}`;
}

function phaseNoun(phases: readonly Phase[]): string {
	if (phases.length > 2) return "a machine";
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

function plugDetail(m: Machine, nic: NicNo): string {
	const plug = plugsOf(m.life)[nic];
	if (plug?.kind !== "port") return "no cable";
	return `port ${plug.port} · ${plug.link === "up" ? "up" : "down"}`;
}

function machineSuggestion(m: Machine, insert: string = m.name): Suggestion {
	return { insert, label: m.name, detail: `${addressText(m)} · ${linkWord(m)}`, hue: m.hue };
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

export function image(): Value<string> {
	return {
		kind: "positional",
		label: "image",
		noun: "an image such as alpine",
		about:
			"alpine, debian or lab: Alpine with iproute2, tcpdump, curl, dig, ssh, nginx, strace, sfdisk and mkfs installed, for use offline.",
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

function nameFault(text: string, fault: NameFault): string {
	switch (fault.kind) {
		case "unreadable": {
			const lower = text.toLowerCase();
			const reads = !isNameFault(parseChosenName(lower));
			return reads
				? `--name wants lowercase letters, so use ${lower}.`
				: `--name wants lowercase letters, digits and hyphens, starting with a letter and not ending with a hyphen, such as web-1, not ${text}.`;
		}
		case "too-long":
			return `--name wants at most ${MAX_NAME} characters, and that is ${fault.length}.`;
		case "lab":
			return `The lab gives out ${text} itself, so use another name, such as web-1.`;
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
			"A name for the machine, which is also its hostname: lowercase letters, digits and hyphens, such as web-1. Left out, node and a number.",
		read(text) {
			const name = parseChosenName(text);
			return isNameFault(name) ? new Miss(nameFault(text, name), undefined, false) : name;
		},
		suggest: () => [],
		format: String,
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
		return `${verb} wants a path with no . or .. in it, not ${path}.`;
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
		schema: { type: "string" },
	};
}

/** The machines one part of a comma list names: `node2`, `node*` or `all`. */
function matchMachines(lab: LabState, part: string, span: Miss["part"]): readonly Machine[] | Miss {
	const all = machinesOf(lab);
	if (part === ALL_MACHINES) return all;
	if (part.includes("*")) {
		const matched = all.filter((m) => globMatch(part, m.name));
		return matched.length > 0 ? matched : new Miss(`No machine matches ${part}. ${youHave(lab)}`, span);
	}
	const m = findMachine(lab, part);
	return m ? [m] : new Miss(noMachine(lab, part), span);
}

function nothingToActOn(ctx: ReadContext, skipped: Selection["skipped"]): Miss {
	const why =
		skipped.length === 0 ? youHave(ctx.lab) : `Skipped ${skipped.map((s) => `${s.name}: ${s.reason}`).join("; ")}.`;
	return new Miss(`${ctx.verb} has no machine to act on. ${why}`, undefined, false);
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
						skipped.push({ name: m.name, reason: PHASE_WORDS[m.life.phase].skipped });
					}
				}
			}
			if (picked.length === 0) return nothingToActOn(ctx, skipped);
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
					return new Miss(
						`No NIC is called ${asked}. A machine has ${list(NICS.map(nicName), "or")}.`,
						{ start, end },
						false,
					);
				}
				for (const m of matched) {
					const has = nicsOf(ctx.lab, m.name);
					const refs = asked === null ? has : has.filter((ref) => ref.nic === nic);
					if (!allowed(m, ctx)) {
						skip(m.name, PHASE_WORDS[m.life.phase].skipped);
					} else if (refs.length > 0) {
						for (const ref of refs) picked.set(`${ref.machine}:${ref.nic}`, ref);
					} else if (named === m.name) {
						const names = list(
							has.map((ref) => nicName(ref.nic)),
							"and",
						);
						return new Miss(`${m.name} has no NIC called ${asked}. It has ${names}.`, { start, end }, false);
					} else {
						skip(m.name, `no ${asked}`);
					}
				}
			}
			if (picked.size === 0) return nothingToActOn(ctx, skipped);
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
							return { insert: head + label, label, detail: plugDetail(m, nic), hue: m.hue };
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

/** What each NIC is plugged into: one answer for all of them, or a comma list with one for each. */
export function networks(): Value<string> {
	return {
		kind: "positional",
		label: "network,...",
		noun: "switch0 or none",
		about:
			"switch0 or none for every NIC, or a comma list with one for each, eth0 first, such as switch0,none. A NIC with none boots unplugged.",
		read(text) {
			for (const { part, ...span } of listParts(text)) {
				if (NETWORKS.every((network) => network !== part)) return new Miss(undefined, span);
			}
			return text;
		},
		suggest(typed) {
			const head = typed.slice(0, typed.lastIndexOf(",") + 1);
			return NETWORKS.map((network) => ({ insert: head + network, label: network }));
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

/** Which captured frames to show. */
export function frameFilter(): Rest {
	return text(
		"filter",
		"Terms that must all match, with or between alternatives: a protocol, machine, NIC (node2:eth1), address, MAC or port:N. Empty, every frame.",
	);
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
