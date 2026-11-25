import type { LabState } from "../model/index.ts";
import type { AnyVerb, Command, CommandDeps, CommandFace, ParsedLine, VerbSpec } from "./define.ts";
import { oneEditFix } from "./grammar/fix.ts";
import { tokenize } from "./grammar/tokenize.ts";
import { type Completion, type LineError, lineError } from "./types.ts";

export type { Approval } from "./approval.ts";
export type {
	AnyVerb,
	ApprovedRunContext,
	Command,
	CommandDeps,
	CommandFace,
	DangerCommand,
	DangerLine,
	DangerVerbDefinition,
	ExecOutcome,
	ExecPort,
	FileOutcome,
	FilePort,
	GuestFile,
	ParsedLine,
	SafeCommand,
	SafeLine,
	SafeVerbDefinition,
	ToolAnnotations,
	ToolFace,
	ToolSpec,
	VerbSpec,
} from "./define.ts";
export { defineVerb, Refusal, refuse } from "./define.ts";
export type { Parsed } from "./grammar/parse.ts";
export type { ArgsOf, Flag, Grammar, Options, ReadContext, Selection, Slot, Value, Variant } from "./grammar/slots.ts";
export * as slots from "./grammar/slots.ts";
export { tokenize } from "./grammar/tokenize.ts";
export { type CommandService, type CommandServiceDeps, createCommandService } from "./service.ts";
export type {
	Completion,
	ConfirmText,
	JsonSchema,
	LineError,
	Preview,
	ReportBlock,
	Result,
	RunContext,
	Suggestion,
	Token,
	Tokenized,
} from "./types.ts";
export { changedSinceAsked, isLineError, NOTHING_CHANGED } from "./types.ts";
export * from "./verbs/index.ts";

/** The single list of commands. The bar's verbs group, completion and the agent tool table all read it. */
export interface Registry {
	/** In registration order. */
	readonly commands: readonly CommandFace[];
	find(name: string): CommandFace | undefined;
	/** A typed handle for buttons and forms: `registry.command(rm).run(args, ctx)`. */
	command<A, D extends boolean>(verb: VerbSpec<string, A, D>): Command<A, D>;
}

export function createRegistry(deps: CommandDeps, verbs: readonly AnyVerb[]): Registry {
	const byName = new Map<string, CommandFace>();
	for (const verb of verbs) {
		if (byName.has(verb.name)) throw new Error(`createRegistry: two verbs are called ${verb.name}`);
		byName.set(verb.name, verb.bind(deps));
	}
	return {
		commands: [...byName.values()],
		find: (name) => byName.get(name),
		command(verb) {
			if (!verbs.includes(verb)) throw new Error(`createRegistry: ${verb.name} is not registered`);
			return verb.bind(deps);
		},
	};
}

/** Bar and agent both enter here: the verb, with a fix for a misspelt one, then that verb's own parse. */
export function parseLine(registry: Registry, line: string, lab: LabState): ParsedLine | LineError {
	const tokenized = tokenize(line);
	const [verb] = tokenized.tokens;
	const names = registry.commands.map((c) => c.name);
	if (!verb) return lineError(`Type a verb first: ${names.join(", ")}.`);
	const command = registry.find(verb.text);
	if (!command) {
		return lineError(
			`No verb called ${verb.text}. The verbs are ${names.join(", ")}.`,
			0,
			oneEditFix(line, verb, names),
		);
	}
	return command.read(tokenized, lab);
}

/** Verbs while the caret is on the first token; after that, the verb's own completion. */
export function completeLine(registry: Registry, line: string, caret: number, lab: LabState): Completion {
	const [verb] = tokenize(line).tokens;
	if (!verb || caret <= verb.end) {
		const start = verb && caret >= verb.start ? verb.start : caret;
		const end = verb && caret >= verb.start ? verb.end : caret;
		const typed = line.slice(start, caret);
		const suggestions = registry.commands
			.filter((c) => c.name.startsWith(typed))
			.map((c) => ({ insert: c.name, label: c.name, detail: c.about }));
		return { replace: { start, end }, suggestions, slot: null };
	}
	const command = registry.find(verb.text);
	return command
		? command.complete(line, caret, lab)
		: { replace: { start: caret, end: caret }, suggestions: [], slot: null };
}

export type { CableState, ExecData, ExecRun, ListedMachine, RemoveData, SpawnData, WriteData } from "./verbs/index.ts";
/** The one verb list. Everything that runs a line builds its registry from it. */
export { VERBS } from "./verbs/index.ts";
