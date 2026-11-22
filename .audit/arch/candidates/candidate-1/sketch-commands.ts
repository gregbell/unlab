// src/commands/** : the one command layer. Imports domain and wire/filter only.
// It reaches the world through two ports (LabPort, ConsolePort) that app.ts fills with
// runtime/ and terminal/; unit tests fill them with fakes.
//
// Files: commands/grammar.ts (tokens, params, targets)  commands/define.ts
//        commands/verbs/{spawn,rm,ls,exec,sh,link,capture,focus,read,frames}.ts
//        commands/index.ts (the registry + Commands)  commands/bar-model.ts

import type { MachineName, MachineSpec, PortNo, ReadStore, SessionId, Source, State, UiEvent, CommandEvent, Policy, Cause } from "./sketch-domain.ts";
import type { CaptureLog } from "./sketch-runtime-wire.ts";

const NI = (): never => {
	throw new Error("not implemented");
};

// ───────────────────────── the handoff's contract, kept ─────────────────────────

export interface LineError {
	/** 'link wants up or down here, not dwon.' */
	message: string;
	/** Index of the offending token, for the carets. Absent for button and agent calls. */
	token?: number;
	/** 'link down node3', when one edit repairs the line. */
	fix?: string;
}
export const isLineError = (x: unknown): x is LineError => typeof x === "object" && x !== null && "message" in x && !("ok" in x);

export interface Suggestion {
	/** Replaces the token under the caret. */
	text: string;
	/** `10.88.0.12 · up`, `256 MiB`, the verb's one-line description. */
	detail?: string;
	/** Machine suggestions render in their hue. */
	machine?: MachineName;
}

/** What a command hands back. The bar closes on `done`; it stays open on anything to read. */
export type Result =
	| { is: "done"; summary: string; data: unknown }
	| { is: "table"; summary: string; columns: string[]; rows: string[][]; data: unknown }
	| {
			is: "exec";
			/** `ran in 3 consoles in 1.0 s · 2 failed` */
			summary: string;
			runs: { machine: MachineName; session: SessionId; exitCode: number | null; lastLine: string; output: string }[];
			skipped: Skipped[];
			data: unknown;
	  }
	| { is: "failed"; error: LineError };

export interface RunContext {
	source: Source;
	signal: AbortSignal;
}

/**
 * The handoff's `Command<Args>`, with three additions that each remove a hand-synced copy:
 *   format  — the inverse of parse, so button and agent calls log in bar grammar
 *   action  — the button label an approval shows (`Remove node3`)
 *   tool    — the WebMCP face of this command, declared next to it
 * and one split: `parse` returns Raw (targets as written: `node*`, `all`); `pin` turns
 * Raw into Args (targets as names) once, at Enter or at the agent's call, so the preview
 * a person approves names exactly the machines that `run` will touch.
 */
export interface Command<Args, Raw = Args> {
	name: string;
	about: string;
	signature: string[];
	danger: boolean;
	/** false for the two agent-only reads (`read`, `frames`). */
	bar: boolean;

	parse(tokens: string[]): Raw | LineError;
	complete(tokens: string[], lab: State): Suggestion[];
	pin(raw: Raw, lab: State): Args | LineError;
	validate(args: Args, lab: State): LineError | null;
	preview(args: Args, lab: State): string;
	action(args: Args): string;
	/** Present iff `danger`: the question, what is lost, who else is affected. */
	confirm?(args: Args, lab: State): { title: string; detail: string };
	format(args: Args): string;
	run(args: Args, ctx: RunContext): Promise<Result>;

	tool?: ToolFace<Raw>;
}

export interface ToolFace<Raw> {
	/** `machines_spawn` */
	name: string;
	description: string;
	defaultPolicy: Policy;
	annotations?: { readOnlyHint?: boolean; consequentialHint?: boolean; untrustedContentHint?: boolean };
	/** One declaration gives both the JSON Schema and the parser; see agent/shape.ts. */
	input: Shape<Raw>;
	/** What the agent gets back; defaults to `result.data`. */
	output?(result: Result): unknown;
}
export interface Shape<T> {
	jsonSchema: object;
	parse(input: unknown): T | LineError;
}

// ───────────────────────── grammar.ts: declare params, derive the rest ─────────────────────────

export interface Token {
	text: string;
	start: number;
	end: number;
}
/** Splits on spaces; a bare `--` ends parsing and the rest becomes one passthrough token. */
export function tokenise(_line: string): { tokens: Token[]; passthrough: string | null } {
	return NI();
}

export type TargetExpr = { is: "all" } | { is: "glob"; prefix: string } | { is: "names"; names: string[] };
export interface Skipped {
	name: MachineName;
	/** `still booting` */
	reason: string;
}
export interface Targets {
	names: MachineName[];
	skipped: Skipped[];
}
/**
 * `all` and globs expand to ready machines and report the rest as skipped. A name that
 * does not exist is a LineError in the handoff's words, with `fix` when one edit away:
 * `No machine called node7. You have node1, node2, node3.`
 */
export function pinTargets(_expr: TargetExpr, _lab: State, _token?: number): Targets | LineError {
	return NI();
}

/** One argument position or option. Parsing, completion, signature text and formatting all come from here. */
export interface Param<Raw, Value = Raw> {
	label: string;
	flag?: string;
	default?: Value;
	parse(text: string): Raw | string;
	suggest(prefix: string, lab: State): Suggestion[];
	pin?(raw: Raw, lab: State, token: number): Value | LineError;
	format(value: Value): string;
}
export const P = {
	int: (_label: string, _range: { min: number; max: number }): Param<number> => NI(),
	image: (): Param<string> => NI(),
	oneOf: <const T extends string>(_label: string, _choices: readonly T[]): Param<T> => NI(),
	machines: (): Param<TargetExpr, Targets> => NI(),
	/** `node2` (its active tab) or `node2:sh1`. */
	session: (): Param<string, SessionId> => NI(),
	/** Everything after `--`. */
	rest: (_label: string): Param<string> => NI(),
	flag: <R, V>(_flag: string, _p: Param<R, V>, _dflt: V): Param<R, V> => NI(),
	switchFlag: (_flag: string): Param<boolean> => NI(),
};
type Params = Record<string, Param<never, unknown> | Param<any, any>>;
type RawOf<Ps> = { [K in keyof Ps]: Ps[K] extends Param<infer R, any> ? R : never };
type ArgsOf<Ps> = { [K in keyof Ps]: Ps[K] extends Param<any, infer V> ? V : never };

/**
 * A verb is its params plus five functions. `signature`, `parse`, `complete`, `pin`,
 * `format` and the tool's input Shape are derived from `params`, so there is one
 * description of each verb's grammar. A wrong token yields
 * `<verb> wants <label> here, not <token>.` with the nearest choice as `fix`.
 */
export function defineCommand<const Ps extends Params>(_def: {
	name: string;
	about: string;
	danger?: boolean;
	bar?: boolean;
	params: Ps;
	validate(args: ArgsOf<Ps>, lab: State): LineError | null;
	preview(args: ArgsOf<Ps>, lab: State): string;
	action(args: ArgsOf<Ps>): string;
	confirm?(args: ArgsOf<Ps>, lab: State): { title: string; detail: string };
	run(args: ArgsOf<Ps>, ctx: RunContext): Promise<Result>;
	tool?: Omit<ToolFace<RawOf<Ps>>, "input">;
}): Command<ArgsOf<Ps>, RawOf<Ps>> {
	return NI();
}

// ───────────────────────── ports ─────────────────────────

/** What verbs need from the runtime. `LabRuntime` satisfies it structurally. */
export interface LabPort {
	spawn(count: number, spec: MachineSpec): MachineName[];
	bootAgain(name: MachineName): void;
	remove(name: MachineName): Promise<void>;
	setLink(name: MachineName, up: boolean, cause: Cause): void;
	openShell(name: MachineName): SessionId;
}

/** What verbs need from terminals. `Terminals` (terminal/) satisfies it. */
export interface ConsolePort {
	/**
	 * Types `line` + Enter into the session, opens a gutter mark in the source's colour,
	 * and resolves when the shell is back at a prompt: the mark closes there. Aborting
	 * stops waiting and closes the mark; it does not interrupt the guest.
	 */
	inject(session: SessionId, line: string, source: Source, signal: AbortSignal): Promise<{ exitCode: number | null; lastLine: string; output: string; ms: number }>;
	/** The last `lines` rendered lines (text, no escapes), for `shell_read`. */
	read(session: SessionId, lines: number): string[];
}

export interface Deps {
	store: ReadStore;
	lab: LabPort;
	consoles: ConsolePort;
	capture: CaptureLog;
	/** For the verbs whose whole effect is on screen (`focus`, `capture`) and for the log. */
	dispatch(event: UiEvent | CommandEvent): void;
	now(): number;
}

// ───────────────────────── verbs, sketched ─────────────────────────

export function verbs(deps: Deps) {
	const { lab, consoles } = deps;

	const spawn = defineCommand({
		name: "spawn",
		about: "Boots machines",
		params: {
			count: P.int("<count>", { min: 1, max: 8 }),
			image: P.image(),
			mem: P.flag("--mem", P.int("MiB", { min: 64, max: 2048 }), 256),
			noNet: P.switchFlag("--no-net"),
		},
		validate: (a, s) => {
			// TODO: 8 - machines < count → `The lab holds 8 machines. You have 6.`
			// TODO: !a.noNet && freePorts(s).length < count →
			//       `switch0 has 2 free ports. Add --no-net to boot them unplugged.` fix: line + ' --no-net'
			void a, s;
			return NI();
		},
		// 'boot node4 and node5 · alpine 3.24 · 256 MiB · ports 4 and 5 on switch0'
		preview: (_a, _s) => NI(),
		action: (a) => (a.count === 1 ? "Boot 1 machine" : `Boot ${a.count} machines`),
		run: async (a) => {
			const names = lab.spawn(a.count, { image: a.image, memMiB: a.mem, net: !a.noNet });
			return { is: "done", summary: `booting ${names.join(", ")}`, data: { names } };
		},
		tool: { name: "machines_spawn", description: "Boot new machines on the lab network.", defaultPolicy: "ask" },
	});

	const link = defineCommand({
		name: "link",
		about: "Plugs in or cuts cables",
		params: { state: P.oneOf("up or down", ["up", "down"]), machines: P.machines() },
		validate: (a) => (a.machines.names.length ? null : { message: "link found no ready machine to act on." }),
		// 'cut the cable from node3 to port 3' | 'plug node5 into port 4, the lowest free'
		preview: (_a, _s) => NI(),
		action: (a) => `${a.state === "up" ? "Reconnect" : "Cut"} ${a.machines.names.join(", ")}`,
		run: async (a, ctx) => {
			for (const name of a.machines.names) lab.setLink(name, a.state === "up", ctx.source);
			// TODO: data = [{ name, port, link }] read back from deps.store.state
			return { is: "done", summary: NI(), data: NI() };
		},
		tool: { name: "link_set", description: "Plug in or cut machines' cables.", defaultPolicy: "run" },
	});

	const rm = defineCommand({
		name: "rm",
		about: "Removes machines and their disks",
		danger: true,
		// rm alone also accepts booting and failed machines; P.machines takes that as an option in the real code.
		params: { machines: P.machines() },
		validate: (a) => (a.machines.names.length ? null : { message: "rm wants at least one machine." }),
		preview: (a) => `remove ${a.machines.names.join(", ")} and their disks`,
		action: (a) => `Remove ${a.machines.names.join(", ")}`,
		// 'Remove node3?' / 'Its disk and 2 shells are lost. node1 and node2 lose a neighbour.'
		confirm: (_a, _s) => NI(),
		run: async (a) => {
			await Promise.all(a.machines.names.map((n) => lab.remove(n)));
			return { is: "done", summary: `removed ${a.machines.names.join(", ")}`, data: { names: a.machines.names } };
		},
		tool: { name: "machines_remove", description: "Remove machines and their disks.", defaultPolicy: "ask", annotations: { consequentialHint: true } },
	});

	const exec = defineCommand({
		name: "exec",
		about: "Runs a shell command in each machine's active session",
		params: { machines: P.machines(), command: P.rest("-- <command>") },
		validate: (a, s) => {
			// TODO: any target whose active session has activity 'busy' →
			//       `node2 is busy in console. exec would type into that program.`
			void a, s;
			return NI();
		},
		preview: (a) => `type \`${a.command}\` into ${a.machines.names.length} consoles`,
		action: (a) => `Run in ${a.machines.names.join(", ")}`,
		run: async (a, ctx) => {
			const t0 = deps.now();
			const runs = await Promise.all(
				a.machines.names.map(async (machine) => {
					const session = deps.store.state.machines[machine]!.activeTab;
					const r = await consoles.inject(session, a.command, ctx.source, ctx.signal);
					return { machine, session, exitCode: r.exitCode, lastLine: r.lastLine, output: r.output };
				}),
			);
			const failed = runs.filter((r) => r.exitCode !== 0).length;
			const summary = `ran in ${runs.length} consoles in ${((deps.now() - t0) / 1000).toFixed(1)} s${failed ? ` · ${failed} failed` : ""}`;
			return { is: "exec", summary, runs, skipped: a.machines.skipped, data: runs };
		},
		tool: { name: "shell_exec", description: "Run a shell command in a machine's console.", defaultPolicy: "run", annotations: { untrustedContentHint: true } },
	});

	// ls, sh, capture, focus, read (shell_read), frames (capture_read): same shape.
	return { spawn, rm, exec, link } as const;
}

// ───────────────────────── index.ts: the one way in ─────────────────────────

export type Verbs = ReturnType<typeof verbs>;
export type VerbName = keyof Verbs;
type RawFor<N extends VerbName> = Verbs[N] extends Command<any, infer R> ? R : never;

/**
 * A validated, pinned, described intent. The ONLY thing `execute` accepts, and only
 * `prepare*` can make one (the brand is module-private): nothing runs unvalidated, and
 * what a confirm or approval block shows is by construction what will run.
 */
export interface Prepared {
	readonly verb: string;
	/** Canonical bar grammar: goes in the log and in `recent`. */
	readonly line: string;
	readonly source: Source;
	readonly danger: boolean;
	/** 'will …' text. The agent approval block shows this same string. */
	readonly preview: string;
	/** `Left out, so assumed: --mem 256 --net switch0`, or null. */
	readonly assumed: string | null;
	readonly action: string;
	readonly confirm: { title: string; detail: string } | null;
	readonly [prepared]: true;
}
declare const prepared: unique symbol;

export interface Commands {
	readonly verbs: Verbs;
	/** Bar, on Enter. */
	prepareLine(line: string, source: Source): Prepared | LineError;
	/** Buttons and agent tools. Same pin → validate → preview path as a typed line. */
	prepare<N extends VerbName>(verb: N, raw: RawFor<N>, source: Source): Prepared | LineError;
	/**
	 * Re-validates against the state as it is NOW (an approval may have waited minutes),
	 * logs `command/started` with the source, runs, logs `command/finished`. Never rejects:
	 * a throw from `run` becomes `{ is: 'failed' }` in the same error block.
	 */
	execute(p: Prepared, signal?: AbortSignal): Promise<Result>;
	/** Bar, on every keystroke. Pure over (line, caret, state); never shows an error by itself. */
	analyse(line: string, caret: number): BarModel;
}
export function createCommands(_deps: Deps): Commands {
	return NI();
}

// ───────────────────────── bar-model.ts ─────────────────────────

export interface BarModel {
	tokens: Token[];
	/** Signature row: labels with the index under the caret. */
	signature: { parts: string[]; active: number } | null;
	suggestions: Suggestion[];
	/** `tab → alpine` | `↵ run` | `↵ again to remove` */
	hint: string;
	/** Set as soon as the line pins and validates. */
	ready: Prepared | null;
	/** Held back until Enter. */
	error: LineError | null;
}

/** The panel's own state machine. Element-local, pure, table-tested against the keyboard map. */
export type BarState =
	| { is: "editing"; line: string; caret: number; choice: number; shownError: LineError | null }
	| { is: "confirming"; line: string; prepared: Prepared }
	| { is: "running"; line: string }
	| { is: "result"; line: string; result: Result };
export type BarKey = "enter" | "mod-enter" | "tab" | "up" | "down" | "esc" | { digit: PortNo } | { input: string; caret: number };
export type BarEffect = { run: Prepared; keepOpen: boolean } | { close: true } | { focusRail: number } | null;
export function barStep(_state: BarState, _key: BarKey, _model: BarModel, _history: readonly string[]): { state: BarState; effect: BarEffect } {
	return NI();
}
