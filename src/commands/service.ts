import type { LabState, Source } from "../model/index.ts";
import type { ParsedLine } from "./define.ts";
import { completeLine, parseLine, type Registry } from "./index.ts";
import { type Completion, isLineError, type LineError, lineError, type Result } from "./types.ts";

/**
 * What elements use to run lines. It lives here, not in ui/services.ts,
 * because commands may not import ui.
 */
export interface CommandService {
	/** The verbs, for the bar's pure model, which parses against the lab it is given. */
	readonly registry: Registry;
	/** Parse against the current state: the bar's preview, error and confirm all start here. */
	parse(line: string): ParsedLine | LineError;
	complete(line: string, caret: number): Completion;
	/**
	 * Run a line that is not dangerous, as `source`. A dangerous line (`rm node3`)
	 * is refused here: it needs a person's yes, so a button calls `confirmInBar`.
	 */
	run(line: string, source: Exclude<Source, "agent">, signal?: AbortSignal): Promise<Result | LineError>;
	/** Open the command bar on `line`, already showing its confirmation. */
	confirmInBar(line: string): void;
}

export interface CommandServiceDeps {
	readonly registry: Registry;
	readonly store: { readonly state: LabState };
	readonly openBar: (line: string) => void;
}

export function createCommandService({ registry, store, openBar }: CommandServiceDeps): CommandService {
	const parse = (line: string) => parseLine(registry, line, store.state);
	return {
		registry,
		parse,
		complete: (line, caret) => completeLine(registry, line, caret, store.state),
		async run(line, source, signal = new AbortController().signal) {
			const parsed = parse(line);
			if (isLineError(parsed)) return parsed;
			if (parsed.danger) {
				return lineError(`${parsed.line} asks first, so it runs from the command bar once you say yes there.`);
			}
			return parsed.run({ source, signal });
		},
		confirmInBar: openBar,
	};
}
