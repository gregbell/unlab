import type { HueNo, Identity, MachineName, SessionId, Source } from "../model/index.ts";

export interface Token {
	readonly text: string;
	/** Character offsets into the line, for carets and caret-to-token lookup. */
	readonly start: number;
	readonly end: number;
}

export interface Tokenized {
	readonly line: string;
	/** A bare `--`, when present, is the last token. */
	readonly tokens: readonly Token[];
	/** Everything after a bare `--`, untouched apart from the spaces that separate it from `--`. */
	readonly passthrough: string | null;
}

/** The handoff's error contract. Every message ends in `Nothing was changed.` */
export interface LineError {
	readonly message: string;
	/** Index into the line's tokens (the verb is 0), for the carets. */
	readonly token?: number;
	/** The whole line with one token repaired, when exactly one repair is close. */
	readonly fix?: string;
}

export interface Suggestion {
	/** The full text that replaces the token under the caret. */
	readonly insert: string;
	readonly label: string;
	/** `10.88.0.12 · up` */
	readonly detail?: string;
	readonly hue?: HueNo;
}

export interface Completion {
	/** The span of the line that a chosen suggestion replaces. */
	readonly replace: { readonly start: number; readonly end: number };
	/** Already filtered by what is typed before the caret; the first is the chosen one. */
	readonly suggestions: readonly Suggestion[];
	/** Index into the command's signature of the argument under the caret, for the underline. */
	readonly slot: number | null;
}

export interface Preview {
	/** Follows the word `will`: `boot node4 and node5 · alpine · 256 MiB`. */
	readonly will: string;
	/** `Left out, so assumed: --mem 256 --net switch0` */
	readonly assumed: string | null;
	readonly tone: "plain" | "warn";
}

export interface ConfirmText {
	/** `Remove node3?` */
	readonly question: string;
	/** What is lost and who else is affected. */
	readonly detail: string;
	/** `Remove node3`, never "OK" or "Allow". */
	readonly actionLabel: string;
	/** Whose it is, by number too: a name can be another machine's by the time it runs. */
	readonly machines: readonly Pick<Identity, "n" | "name">[];
}

export interface ReportBlock {
	readonly machine: MachineName;
	readonly hue: HueNo;
	readonly status:
		| { readonly kind: "exit"; readonly code: number }
		| { readonly kind: "unknown" }
		| { readonly kind: "skipped"; readonly reason: string }
		/** An `ls` row: `ready`, `booting`, `failed`. */
		| { readonly kind: "state"; readonly text: string };
	/** The last line of output, or for `ls` the machine in one line. */
	readonly lastLine: string;
	readonly focus: SessionId | null;
}

export type Result =
	/** The effect is visible in the lab, so the bar closes. */
	| { readonly kind: "visible"; readonly text: string; readonly data: unknown }
	/** Something to read, so the bar stays open. */
	| {
			readonly kind: "report";
			readonly header: string;
			readonly blocks: readonly ReportBlock[];
			readonly data: unknown;
	  }
	| { readonly kind: "failed"; readonly error: LineError };

export interface RunContext {
	readonly source: Source;
	readonly signal: AbortSignal;
}

export type JsonSchema = {
	readonly type?: "object" | "string" | "integer";
	readonly description?: string;
	readonly enum?: readonly string[];
	readonly minimum?: number;
	readonly default?: string | number;
	readonly properties?: Readonly<Record<string, JsonSchema>>;
	readonly required?: readonly string[];
	readonly additionalProperties?: boolean;
	readonly anyOf?: readonly JsonSchema[];
};

export const NOTHING_CHANGED = "Nothing was changed.";

/** Every error the engine reports happened before anything ran, so it says so. */
export function lineError(message: string, token?: number, fix?: string): LineError {
	return {
		message: `${message} ${NOTHING_CHANGED}`,
		...(token === undefined ? {} : { token }),
		...(fix === undefined ? {} : { fix }),
	};
}

/** Why a yes to `asked` is not a yes to `now`, or null when they ask the same of the same machines. */
export function changedSinceAsked(asked: ConfirmText, now: ConfirmText): LineError | null {
	if (JSON.stringify(asked) === JSON.stringify(now)) return null;
	return lineError(`What this does to ${asked.machines.map((m) => m.name).join(", ")} has changed since it was asked.`);
}

export function isLineError(value: object): value is LineError {
	return "message" in value;
}
