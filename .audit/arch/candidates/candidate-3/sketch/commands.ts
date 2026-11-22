// src/commands/* — one registry, one `run` per verb. The bar, buttons and
// WebMCP tools all end in `command.run(args, { source, signal, approval })`.
//
// A verb is written as four things: a grammar, a plan, a description of the
// plan, and an executor. Everything else on the spec's Command<Args>
// (signature, parse, complete, validate, preview, the "did you mean" fix,
// the agent tool's input schema and its bar-grammar log line) is derived.

import type {
	Cause, HueNo, LabState, LinkChange, MachineName, PlanError, PortNo, SessionId, Source, SpawnPlan, Store, ToolName,
} from "./model.ts";

// ───────────────────────────── the spec's contract ─────────────────────────────

export interface LineError {
	readonly message: string; // 'link wants up or down here, not dwon.'
	readonly token?: number; // offending token index, for the carets
	readonly fix?: string; // 'link down node3' — computed by the grammar, never by a verb
}

export interface Suggestion {
	readonly insert: string;
	readonly label: string;
	readonly detail?: string; // '10.88.0.12 · up'
	readonly hue?: HueNo;
}

export interface Preview {
	readonly will: string; // 'boot node4 and node5 · alpine · ports 4 and 5 · 256 MiB'
	readonly assumed: string | null; // 'Left out, so assumed: --mem 256 --net switch0'
	readonly tone: "plain" | "warn"; // warn when danger
}

export interface ConfirmText {
	readonly question: string; // 'Remove node3?'
	readonly detail: string; // 'Its disk and 2 shells go with it. node1 and node2 lose their cable peer on port 3.'
	readonly actionLabel: string; // 'Remove node3' — never "OK" or "Allow"
}

/** A user said yes. Only commands/approval.ts mints these; only ui/command-bar and agent/ may import it (scripts/check-imports.ts). */
declare const approved: unique symbol;
export interface Approval {
	readonly [approved]: true;
	readonly line: string;
}
export function grantApproval(line: string): Approval {
	throw new Error("not implemented");
}

export interface RunContext {
	readonly source: Source;
	readonly signal: AbortSignal;
}
/** Danger verbs cannot be run without an Approval: the bar's second Enter, the confirm block's button, or an agent approval. */
export type RunContextFor<D extends boolean> = D extends true ? RunContext & { readonly approval: Approval } : RunContext;

export type ReportBlock = {
	readonly machine: MachineName;
	readonly hue: HueNo;
	readonly status: { kind: "exit"; code: number } | { kind: "unknown" } | { kind: "skipped"; reason: string };
	readonly lastLine: string;
	readonly focus: SessionId | null;
};

export type Result =
	| { readonly kind: "visible"; readonly text: string; readonly data: unknown } // bar closes
	| { readonly kind: "report"; readonly header: string; readonly blocks: readonly ReportBlock[]; readonly data: unknown } // bar stays open
	| { readonly kind: "failed"; readonly error: LineError }; // same block as a parse error

export interface Command<Args, D extends boolean = boolean> {
	readonly name: Verb;
	readonly signature: readonly string[]; // derived from grammar
	readonly danger: D;
	parse(tokens: readonly Token[]): Parsed<Args> | LineError;
	complete(tokens: readonly Token[], cursorToken: number, lab: LabState): readonly Suggestion[];
	validate(args: Args, lab: LabState): LineError | null;
	preview(args: Args, lab: LabState, assumed: readonly string[]): Preview;
	confirm(args: Args, lab: LabState): D extends true ? ConfirmText : null;
	/** Inverse of parse: the bar-grammar line for the log, `recent`, and agent calls. parse(tokenize(format(a))) ≡ a (property test). */
	format(args: Args): string;
	/**
	 * Re-plans against the store's *current* state (a preview may be stale by
	 * the time an approval lands), executes, then logs `{line, source, outcome}`.
	 * Never throws for user error: returns { kind: 'failed' } with the verb's sentence.
	 */
	run(args: Args, ctx: RunContextFor<D>): Promise<Result>;
}

// ───────────────────────────── grammar (commands/grammar/*) ─────────────────────────────

export interface Token {
	readonly text: string;
	readonly start: number; // char offsets, for carets and cursor → token
	readonly end: number;
}
export interface Tokenized {
	readonly tokens: readonly Token[];
	/** Everything after a bare `--`, untouched (exec's command). */
	readonly passthrough: string | null;
}
export function tokenize(line: string): Tokenized {
	throw new Error("not implemented");
}

export interface Parsed<Args> {
	readonly args: Args;
	/** Option labels left out and defaulted, for the preview's second line. */
	readonly assumed: readonly string[];
}

/**
 * One argument position. The grammar of a verb is an ordered record of
 * slots; parse, complete, signature and format walk it. `expected` lists
 * what this position accepts, which is all the generic fix needs: when the
 * bad token is within edit distance 2 of exactly one expectation, `fix` is the
 * line with that one token replaced.
 */
export interface Slot<T> {
	readonly label: string; // '<count>', '[--mem MiB]'
	readonly kind: "positional" | "option" | "rest" | "passthrough";
	readonly default?: T;
	read(token: Token | undefined, lab: LabState | null, passthrough: string | null): T | SlotMiss;
	expected(lab: LabState): readonly Suggestion[];
	format(value: T): readonly string[];
}
export interface SlotMiss {
	readonly message: string; // in the verb's words; the slot supplies the noun, the verb the sentence
	readonly token: number;
}
export type Grammar = Readonly<Record<string, Slot<unknown>>>;
export type ArgsOf<G extends Grammar> = { readonly [K in keyof G]: G[K] extends Slot<infer T> ? T : never };

// Slot constructors. `machines` expands `all` and globs to *ready* machines and
// records the ones skipped; that is why its value is a Selection, not a list.
export interface Selection {
	readonly machines: readonly MachineName[];
	readonly skipped: readonly { name: MachineName; reason: string }[]; // 'skipped node4: still booting'
	readonly written: string; // as typed, for format()
}
export declare const slots: {
	count(): Slot<number>;
	image(): Slot<string>;
	machines(opts: { phases: readonly ("booting" | "ready" | "failed")[] }): Slot<Selection>;
	machine(): Slot<MachineName>;
	target(): Slot<MachineName | SessionId>; // node2 or node2:sh1
	choice<const C extends string>(choices: readonly C[]): Slot<C>;
	option<T>(flag: `--${string}`, value: Slot<T>, defaultValue: T): Slot<T>;
	exclusive<T>(variants: readonly Slot<T>[], defaultValue: T): Slot<T>; // --net switch0 | --no-net
	flag<T>(flag: `--${string}`, value: T): Slot<T>;
	rest(label: string): Slot<string>; // capture's filter: the remaining tokens joined
	passthrough(label: string): Slot<string>; // after `--`
};

// ───────────────────────────── defineVerb: the one way to make a command ─────────────────────────────

export interface CommandDeps {
	readonly store: Pick<Store, "state" | "dispatchCommand" | "until">;
	readonly exec: ExecPort;
	readonly now: () => number;
}

export interface VerbDefinition<G extends Grammar, P, D extends boolean> {
	readonly name: Verb;
	readonly danger: D;
	readonly grammar: G;
	/** Pure. The only place the verb decides anything. Errors are sentences. */
	plan(args: ArgsOf<G>, lab: LabState): P | LineError;
	describe(plan: P, lab: LabState): string;
	confirm: D extends true ? (plan: P, lab: LabState) => ConfirmText : null;
	/** The shell: dispatch the plan, wait until the effect is visible, report. */
	execute(plan: P, ctx: RunContext, deps: CommandDeps): Promise<Result>;
}

export function defineVerb<G extends Grammar, P, D extends boolean>(def: VerbDefinition<G, P, D>): (deps: CommandDeps) => Command<ArgsOf<G>, D> {
	throw new Error("not implemented");
	// validate(a, lab)  = isLineError(def.plan(a, lab)) ? that : null
	// preview(a, lab)   = { will: def.describe(plan), assumed: assumed.length ? `Left out, so assumed: ${…}` : null, tone: def.danger ? 'warn' : 'plain' }
	// run(a, ctx)       = plan against deps.store.state → failed | def.execute → dispatch cmd/logged { line: format(a), source, outcome }
}

/** Plan errors from model/ become sentences here, once. */
export function sentence(e: PlanError, lab: LabState): LineError {
	throw new Error("not implemented");
	// no-ports → 'switch0 has 2 free ports. Add --no-net to boot them unplugged.'
	// unknown-machine → 'No machine called node7. You have node1, node2, node3.'
}

// ───────────────────────────── the registry: one list ─────────────────────────────

/** `boot` is ours, not the handoff's: "Boot again" changes lifecycle, so it must be a command (rule 5). Bar-reachable, no agent tool. */
export type Verb = "spawn" | "rm" | "ls" | "exec" | "sh" | "link" | "capture" | "focus" | "boot";

/** The single list of verbs. The bar's `verbs` group, help, and the agent tool table all derive from this object. */
export function createRegistry(deps: CommandDeps) {
	return {
		spawn: spawn(deps),
		rm: rm(deps),
		ls: ls(deps),
		exec: exec(deps),
		sh: sh(deps),
		link: link(deps),
		capture: capture(deps),
		focus: focus(deps),
		boot: boot(deps),
	} as const satisfies Record<Verb, { readonly name: Verb; readonly danger: boolean }>; // a missing or extra verb fails the build
}
export type Registry = ReturnType<typeof createRegistry>;

/** Bar and agent both enter here: verb lookup (with fix for a misspelt verb), then that verb's parse. */
export function parseLine(
	registry: Registry,
	line: string,
	lab: LabState,
): { command: Registry[Verb]; parsed: Parsed<unknown>; tokens: Tokenized } | LineError {
	throw new Error("not implemented");
}

// ───────────────────────────── the exec port (implemented by runtime/engine) ─────────────────────────────

export interface InjectOutcome {
	/** null when the shell never reported a status (no OSC 133 D) before the signal or the cap. */
	readonly exitCode: number | null;
	/** Text of the marked rows minus the echoed command line, read from the screen (not raw bytes). */
	readonly output: string;
	readonly ms: number;
}

/** Request/response I/O that changes no reduced state by itself; any state it implies comes back as runtime events (session/shell, session/marked). */
export interface ExecPort {
	/**
	 * Types `line\r` into the session as if typed, opens a gutter mark at the
	 * cursor, closes it at the shell's next command-finished mark (OSC 133 D),
	 * and resolves with its exit status. Rejects with a sentence when the
	 * session is running a program in the foreground (refuse, don't interleave).
	 */
	inject(session: SessionId, line: string, source: Source, signal: AbortSignal): Promise<InjectOutcome>;
	/** Last n rows of the session's screen as text (shell_read). */
	read(session: SessionId, lines: number): string;
}

// ───────────────────────────── four verbs, enough to see the shape ─────────────────────────────

export const spawn = defineVerb({
	name: "spawn",
	danger: false,
	grammar: {
		count: slots.count(),
		image: slots.image(),
		mem: slots.option("--mem", slots.count(), 256),
		net: slots.exclusive<"switch0" | "none">([slots.option("--net", slots.choice(["switch0"]), "switch0"), slots.flag("--no-net", "none")], "switch0"),
	},
	plan(a, lab): SpawnPlan | LineError {
		throw new Error("not implemented"); // planSpawn(lab, a.count, { image: a.image, memMiB: a.mem, net: a.net }) → sentence() on PlanError
	},
	describe(plan) {
		throw new Error("not implemented"); // 'boot node4 and node5 · alpine · 256 MiB · ports 4 and 5'
	},
	confirm: null,
	async execute(plan, ctx, deps) {
		deps.store.dispatchCommand({ type: "cmd/spawn", plan, at: deps.now() });
		// Visible at once: every row and pane appears, booting.
		return { kind: "visible", text: `booting ${plan.machines.map((m) => m.identity.name).join(", ")}`, data: { names: plan.machines.map((m) => m.identity.name) } };
	},
});

export const link = defineVerb({
	name: "link",
	danger: false,
	grammar: {
		dir: slots.choice(["up", "down"] as const),
		targets: slots.machines({ phases: ["ready"] }),
	},
	plan(a, lab): { changes: readonly LinkChange[]; cause?: Cause } | LineError {
		throw new Error("not implemented"); // planLink(lab, a.targets.machines, a.dir === 'up'); up on an unplugged machine allocates
	},
	describe(plan) {
		throw new Error("not implemented"); // 'cut the cable from node3 to port 3' / 'plug node5 into port 6'
	},
	confirm: null,
	async execute(plan, ctx, deps) {
		deps.store.dispatchCommand({ type: "cmd/link", changes: plan.changes, cause: ctx.source });
		return { kind: "visible", text: "", data: plan.changes.map((c) => ({ machine: c.machine, port: c.port, link: c.up ? "up" : "cut" })) };
	},
});

export const rm = defineVerb({
	name: "rm",
	danger: true,
	grammar: { targets: slots.machines({ phases: ["booting", "ready", "failed"] }) },
	plan(a, lab): { machines: readonly MachineName[]; ports: readonly PortNo[] } | LineError {
		throw new Error("not implemented");
	},
	describe(plan) {
		throw new Error("not implemented"); // 'remove node3 and its disk · frees port 3'
	},
	confirm: (plan, lab) => {
		throw new Error("not implemented"); // question naming the machine, what is lost, who else is affected
	},
	async execute(plan, ctx, deps) {
		deps.store.dispatchCommand({ type: "cmd/remove", machines: plan.machines, cause: ctx.source, at: deps.now() });
		// "Closes when teardown ends": resolve when the records are gone.
		await deps.store.until((s) => plan.machines.every((m) => !s.machines[m]), ctx.signal);
		return { kind: "visible", text: `removed ${plan.machines.join(", ")}`, data: { removed: plan.machines } };
	},
});

export const exec = defineVerb({
	name: "exec",
	danger: false,
	grammar: {
		targets: slots.machines({ phases: ["ready"] }), // also accepts node2:sh1 targets
		command: slots.passthrough("<command>"),
	},
	plan(a, lab): { targets: readonly { machine: MachineName; session: SessionId }[]; skipped: Selection["skipped"]; command: string } | LineError {
		throw new Error("not implemented");
		// bare machine → its active session; session.shell === 'running' → skipped "node2:console is running a program"
	},
	describe(plan) {
		throw new Error("not implemented"); // 'type `ping -c1 node3` into node1:console and node2:sh1'
	},
	confirm: null,
	async execute(plan, ctx, deps) {
		const t0 = deps.now();
		const settled = await Promise.allSettled(plan.targets.map((t) => deps.exec.inject(t.session, plan.command, ctx.source, ctx.signal)));
		// One block per machine: exit n (or `exit ?`), last line, a link focusing that console; skipped after.
		// Header: 'ran in 3 consoles in 1.0 s · 2 failed'
		void settled;
		void t0;
		throw new Error("not implemented");
	},
});

// sh, ls, capture, focus follow the same pattern; declared so the registry type-checks.
export declare const ls: (deps: CommandDeps) => Command<{}, false>;
export declare const sh: (deps: CommandDeps) => Command<{ machine: MachineName }, false>;
export declare const capture: (deps: CommandDeps) => Command<{ filter: string }, false>;
export declare const focus: (deps: CommandDeps) => Command<{ target: MachineName | SessionId; mode: "plain" | "main" | "max" }, false>;
export declare const boot: (deps: CommandDeps) => Command<{ machine: MachineName }, false>; // failed → booting, same name/hue/image/mem, lowest free port

// ───────────────────────────── agent tools derive from verbs ─────────────────────────────

export interface ToolBinding<Args> {
	readonly tool: ToolName;
	readonly verb: Verb;
	readonly description: string;
	readonly annotations: { readOnlyHint?: boolean; consequentialHint?: boolean; untrustedContentHint?: boolean };
	/**
	 * Tool input → the bar line. Each scalar must be a single token
	 * (/^\S+$/), so an agent cannot smuggle extra arguments through a field;
	 * the passthrough field is appended after `--` verbatim. The line then goes
	 * through parseLine like anything typed, so the agent gets the command's own
	 * error sentences and the log gets bar grammar for free.
	 */
	toLine(input: unknown): string | LineError;
	/** JSON Schema derived from the verb's grammar slots plus field names. Advisory only; we never trust the browser to enforce it. */
	readonly inputSchema: object;
}
