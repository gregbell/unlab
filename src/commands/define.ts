import type {
	CableCounters,
	CommandEvent,
	LabState,
	LearnedMac,
	Machine,
	MachineName,
	Phase,
	Policy,
	PortRef,
	SessionId,
	Source,
	SwitchName,
	SwitchTotals,
	ToolName,
} from "../model/index.ts";
import type { Approval } from "./approval.ts";
import { complete } from "./grammar/complete.ts";
import { format as formatLine, type Shown, shown, signature as signatureOf } from "./grammar/format.ts";
import { isPlain, type Parsed, parse } from "./grammar/parse.ts";
import { lineFromInput, toolSchema } from "./grammar/schema.ts";
import { type ArgsOf, endsLine, type Grammar, Miss, type ReadContext, readMachine } from "./grammar/slots.ts";
import { type Example, type ExampleOf, type Manual, manualOf } from "./manual.ts";
import {
	type Completion,
	type ConfirmText,
	changedSinceAsked,
	isLineError,
	type JsonSchema,
	type LineError,
	lineError,
	type Preview,
	type Result,
	type RunContext,
	type Tokenized,
} from "./types.ts";

/** What one line typed into a session came to. */
export interface ExecOutcome {
	/** From the shell's OSC 133 D mark. Null when the mark carried no status. */
	readonly exitCode: number | null;
	/** The marked rows as the terminal shows them, without the echoed command line. */
	readonly output: string;
	/** The terminal no longer held the start, so `output` is the end of what was printed. */
	readonly truncated: boolean;
	/** The last line of output that is not blank. */
	readonly lastLine: string;
	readonly ms: number;
}

/** The runtime types into sessions for `exec`. Request and response only: any state it implies comes back as runtime events. */
export interface ExecPort {
	/**
	 * Types `line` and Enter into the session as if typed there, under a line
	 * mark. Resolves when the shell reports the command finished. Rejects with
	 * an Error whose message is a sentence unless the session is open and at a
	 * prompt, and with the signal's reason when aborted.
	 */
	inject(session: SessionId, line: string, source: Source, signal: AbortSignal): Promise<ExecOutcome>;
}

/** A file as it is to be in a guest. */
export interface GuestFile {
	readonly path: string;
	readonly text: string;
	/** Null for what it has, or for a new file root's. */
	readonly owner: string | null;
	/** Null for what it has, or for a new file 644. */
	readonly mode: string | null;
}

export type FileOutcome =
	/** Its path once links are followed, and what it has now. It is on the machine's disk. */
	| { readonly kind: "written"; readonly path: string; readonly owner: string; readonly mode: string }
	/** Nothing in the guest was changed. One sentence. */
	| { readonly kind: "refused"; readonly reason: string }
	/** The guest did not say what it did. The file is as it was or as it was to be. One sentence. */
	| { readonly kind: "unsure"; readonly reason: string };

/** The runtime puts files in guests for `write`, and no terminal sees it. */
export interface FilePort {
	/** Rejects only with the signal's reason when aborted. A write that has begun then goes on. */
	write(machine: MachineName, file: GuestFile, signal: AbortSignal): Promise<FileOutcome>;
}

/** What each switch has learned and counted, which the lab's state does not hold. The switch panel reads the same. */
export interface SwitchReads {
	macTable(of: SwitchName): readonly LearnedMac[];
	totals(of: SwitchName): SwitchTotals;
	/** The switches' clock, which a learned address's `seen` is on. */
	now(): number;
}

/** What a command needs from the lab. The store satisfies it; tests pass a fake. */
export interface CommandDeps {
	state(): LabState;
	dispatch(event: CommandEvent): void;
	/** Resolves with the first state that satisfies the predicate; rejects when the signal aborts. */
	until(predicate: (state: LabState) => boolean, signal: AbortSignal): Promise<LabState>;
	now(): number;
	/** What the cable in the port has carried and dropped, which the switches count and the lab's state does not hold. */
	carried(port: PortRef): CableCounters | undefined;
	readonly switches: SwitchReads;
	readonly exec: ExecPort;
	readonly files: FilePort;
}

/** A plan's "no", in the verb's words. `at` names the argument the carets go under. */
export class Refusal<K extends string = string> {
	constructor(
		readonly message: string,
		readonly at?: K,
	) {}
}

export function refuse<K extends string = never>(message: string, at?: K): Refusal<K> {
	return new Refusal(message, at);
}

/** The machine, unless the lab has changed since its name was read and the verb does not take it now. */
export function machineNow<K extends string>(name: MachineName, ctx: ReadContext, at: K): Machine | Refusal<K> {
	const machine = readMachine(name, ctx);
	return machine instanceof Miss ? refuse(String(machine.message), at) : machine;
}

export interface ApprovedRunContext extends RunContext {
	readonly approval: Approval;
}

export interface ToolAnnotations {
	readonly readOnlyHint?: boolean;
	readonly consequentialHint?: boolean;
	readonly untrustedContentHint?: boolean;
}

export interface ToolSpec {
	readonly name: ToolName;
	/** For people, where the browser lists the tool. */
	readonly title: string;
	readonly policy: Policy;
	readonly annotations?: ToolAnnotations;
}

/** The WebMCP face of a verb, derived from its grammar. */
export interface ToolFace {
	readonly name: ToolName;
	readonly title: string;
	readonly description: string;
	readonly policy: Policy;
	readonly annotations: ToolAnnotations;
	readonly inputSchema: JsonSchema;
	/** Tool input as a bar line, to go through `parseLine` like anything typed. */
	toLine(input: unknown): string | LineError;
	/** Any line of the verb, as the panel shows it. */
	shown(line: string): Shown;
}

interface LineBase {
	readonly verb: string;
	/** The line in canonical bar grammar. */
	readonly line: string;
	/** The line as it will be logged. */
	readonly shown: Shown;
	readonly tokens: Tokenized;
	readonly args: unknown;
	readonly assumed: readonly string[];
	validate(lab: LabState): LineError | null;
	preview(lab: LabState): Preview | LineError;
}

export interface SafeLine extends LineBase {
	readonly danger: false;
	run(ctx: RunContext): Promise<Result>;
}

export interface DangerLine extends LineBase {
	readonly danger: true;
	confirm(lab: LabState): ConfirmText | LineError;
	run(ctx: ApprovedRunContext): Promise<Result>;
}

/** A parsed line with its arguments bound, so the bar and the agent can hold any verb's line. */
export type ParsedLine = SafeLine | DangerLine;

/** What every command offers without knowing its argument type. */
export interface CommandFace {
	readonly name: string;
	readonly about: string;
	readonly danger: boolean;
	/** `['<count>', '<image>', '[--mem MiB]', '[--net switch0 | --no-net]']` */
	readonly signature: readonly string[];
	read(tokenized: Tokenized, lab: LabState): ParsedLine | LineError;
	complete(line: string, caret: number, lab: LabState): Completion;
	readonly manual: Manual;
	readonly tool: ToolFace | null;
}

interface CommandOps<Args> extends CommandFace {
	parse(tokenized: Tokenized, lab: LabState): Parsed<Args> | LineError;
	validate(args: Args, lab: LabState): LineError | null;
	preview(parsed: Parsed<Args>, lab: LabState): Preview | LineError;
	/** The inverse of parse. */
	format(args: Args): string;
}

export interface SafeCommand<Args> extends CommandOps<Args> {
	readonly danger: false;
	/** Re-plans against the current state, executes, and logs the line with its source and outcome. */
	run(args: Args, ctx: RunContext): Promise<Result>;
}

export interface DangerCommand<Args> extends CommandOps<Args> {
	readonly danger: true;
	confirm(args: Args, lab: LabState): ConfirmText | LineError;
	/** As SafeCommand's run, but only with an approval for this exact line, and only while it would ask the same. */
	run(args: Args, ctx: ApprovedRunContext): Promise<Result>;
}

export type Command<Args, D extends boolean = boolean> = D extends true ? DangerCommand<Args> : SafeCommand<Args>;

interface VerbBase<N extends string, G extends Grammar, P> {
	readonly name: N;
	/** One line of it, for the list of verbs. */
	readonly about: string;
	/** The rest that a person or an agent needs to know, for help and the tool. Left out, `about` is all. */
	readonly description?: string;
	readonly grammar: G;
	/** One call that does something useful, for help: the tool's input, which help also shows as a line. */
	readonly example: ExampleOf<G>;
	/** The lifecycle phases the verb's machine arguments accept. Only ready machines take commands unless a verb says otherwise. */
	readonly phases?: readonly Phase[];
	/** Pure. The only place the verb decides anything. */
	plan(args: ArgsOf<G>, lab: LabState, ctx: ReadContext): P | Refusal<Extract<keyof G, string>>;
	/** The preview's `will …` text. */
	describe(plan: P, lab: LabState): string;
	/** Dispatches the plan, waits until its effect is visible, and reports. */
	execute(plan: P, ctx: RunContext, deps: CommandDeps): Promise<Result>;
	readonly tool?: ToolSpec;
}

export interface SafeVerbDefinition<N extends string, G extends Grammar, P> extends VerbBase<N, G, P> {
	readonly danger: false;
	readonly confirm?: undefined;
}

export interface DangerVerbDefinition<N extends string, G extends Grammar, P> extends VerbBase<N, G, P> {
	readonly danger: true;
	/** The question naming the machine, what is lost, and who else is affected. */
	confirm(plan: P, lab: LabState): ConfirmText;
}

export interface VerbSpec<N extends string, Args, D extends boolean> {
	readonly name: N;
	readonly manual: Manual;
	readonly danger: D;
	/** The same command for the same deps, every time. */
	bind(deps: CommandDeps): Command<Args, D>;
}

export interface AnyVerb {
	readonly name: string;
	readonly manual: Manual;
	bind(deps: CommandDeps): CommandFace;
}

function checkGrammar(verb: string, grammar: Grammar): void {
	const slots = Object.values(grammar);
	const positional = slots.filter(isPlain);
	const loose = positional.findIndex((s) => s.kind !== "positional");
	const flags = slots.flatMap((s) => (s.kind === "options" ? s.variants.map((v) => v.flag) : []));
	const fail = (problem: string) => {
		throw new Error(`defineVerb(${verb}): ${problem}`);
	};
	if (loose >= 0 && loose !== positional.length - 1)
		fail("only the last positional argument can be left out or be free text");
	if (slots.filter(endsLine).length > 1) fail("only one argument can follow --");
	if (new Set(flags).size !== flags.length || flags.includes("--")) fail("each option flag must be unique and not --");
}

export function defineVerb<const N extends string, G extends Grammar, P>(
	def: SafeVerbDefinition<N, G, P>,
): VerbSpec<N, ArgsOf<G>, false>;
export function defineVerb<const N extends string, G extends Grammar, P>(
	def: DangerVerbDefinition<N, G, P>,
): VerbSpec<N, ArgsOf<G>, true>;
export function defineVerb<N extends string, G extends Grammar, P>(
	def: SafeVerbDefinition<N, G, P> | DangerVerbDefinition<N, G, P>,
): VerbSpec<N, ArgsOf<G>, boolean> {
	type Args = ArgsOf<G>;
	type Planned = { readonly ok: true; readonly plan: P } | { readonly ok: false; readonly error: LineError };
	checkGrammar(def.name, def.grammar);
	const example: Example = def.example;
	const manual = manualOf(def, example);
	const phases = def.phases ?? ["ready"];
	const context = (lab: LabState): ReadContext => ({ verb: def.name, lab, phases });
	const format = (args: Args) => formatLine(def.name, def.grammar, args);
	const brief = (line: string) => shown(def.grammar, line);

	const planned = (args: Args, lab: LabState, tokenOf?: Parsed<Args>["tokenOf"]): Planned => {
		const plan = def.plan(args, lab, context(lab));
		if (!(plan instanceof Refusal)) return { ok: true, plan };
		return { ok: false, error: lineError(plan.message, plan.at === undefined ? undefined : tokenOf?.[plan.at]) };
	};
	const validate = (args: Args, lab: LabState, tokenOf?: Parsed<Args>["tokenOf"]) => {
		const p = planned(args, lab, tokenOf);
		return p.ok ? null : p.error;
	};
	const approved = (args: Args, line: string, approval: Approval | undefined, lab: LabState): Planned => {
		if (!def.danger) return planned(args, lab);
		if (approval?.line !== line) {
			const error = lineError(`That approval was for ${approval?.line ?? "nothing"}, not ${line}.`);
			return { ok: false, error };
		}
		const p = planned(args, lab);
		const changed = p.ok ? changedSinceAsked(approval.asked, def.confirm(p.plan, lab)) : null;
		return changed ? { ok: false, error: changed } : p;
	};
	const preview = (parsed: Parsed<Args>, lab: LabState): Preview | LineError => {
		const p = planned(parsed.args, lab, parsed.tokenOf);
		if (!p.ok) return p.error;
		return {
			will: def.describe(p.plan, lab),
			assumed: parsed.assumed.length > 0 ? `Left out, so assumed: ${parsed.assumed.join(" ")}` : null,
			tone: def.danger ? "warn" : "plain",
		};
	};
	const tool = (spec: ToolSpec): ToolFace => ({
		name: spec.name,
		title: spec.title,
		description: manual.description,
		policy: spec.policy,
		annotations: spec.annotations ?? {},
		inputSchema: toolSchema(def.grammar),
		toLine: (input) => lineFromInput(def.name, def.grammar, input, example),
		shown: brief,
	});

	const cache = new WeakMap<CommandDeps, Command<Args, boolean>>();
	const bind = (deps: CommandDeps): Command<Args, boolean> => {
		const run = async (args: Args, ctx: RunContext & { readonly approval?: Approval }): Promise<Result> => {
			const line = format(args);
			const log = (outcome: "ok" | "failed") =>
				deps.dispatch({ type: "cmd/logged", line: brief(line).line, source: ctx.source, at: deps.now(), outcome });
			let result: Result;
			const p = approved(args, line, ctx.approval, deps.state());
			if (p.ok) {
				try {
					result = await def.execute(p.plan, ctx, deps);
				} catch (error) {
					log("failed");
					throw error;
				}
			} else {
				result = { kind: "failed", error: p.error };
			}
			log(result.kind === "failed" ? "failed" : "ok");
			return result;
		};

		const parseArgs = (tokenized: Tokenized, lab: LabState) => parse(def.grammar, tokenized, context(lab));
		const ops = {
			name: def.name,
			about: def.about,
			signature: signatureOf(def.grammar),
			manual,
			tool: def.tool ? tool(def.tool) : null,
			parse: parseArgs,
			validate: (args: Args, lab: LabState) => validate(args, lab),
			preview,
			format,
			complete: (line: string, caret: number, lab: LabState) => complete(def.grammar, line, caret, context(lab)),
		};
		const lineOf = (tokenized: Tokenized, parsed: Parsed<Args>) => ({
			verb: def.name,
			line: format(parsed.args),
			shown: brief(format(parsed.args)),
			tokens: tokenized,
			args: parsed.args,
			assumed: parsed.assumed,
			validate: (lab: LabState) => validate(parsed.args, lab, parsed.tokenOf),
			preview: (lab: LabState) => preview(parsed, lab),
		});

		if (def.danger) {
			const confirm = (args: Args, lab: LabState, tokenOf?: Parsed<Args>["tokenOf"]) => {
				const p = planned(args, lab, tokenOf);
				return p.ok ? def.confirm(p.plan, lab) : p.error;
			};
			const command: DangerCommand<Args> = {
				...ops,
				danger: true,
				confirm: (args, lab) => confirm(args, lab),
				run,
				read(tokenized, lab) {
					const parsed = parseArgs(tokenized, lab);
					if (isLineError(parsed)) return parsed;
					return {
						...lineOf(tokenized, parsed),
						danger: true,
						confirm: (now) => confirm(parsed.args, now, parsed.tokenOf),
						run: (ctx) => run(parsed.args, ctx),
					};
				},
			};
			return command;
		}
		const command: SafeCommand<Args> = {
			...ops,
			danger: false,
			run,
			read(tokenized, lab) {
				const parsed = parseArgs(tokenized, lab);
				if (isLineError(parsed)) return parsed;
				return { ...lineOf(tokenized, parsed), danger: false, run: (ctx) => run(parsed.args, ctx) };
			},
		};
		return command;
	};

	return {
		name: def.name,
		manual,
		danger: def.danger,
		bind(deps) {
			const known = cache.get(deps);
			if (known) return known;
			const command = bind(deps);
			cache.set(deps, command);
			return command;
		},
	};
}
