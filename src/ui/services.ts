import type { CaptureView } from "../capture/index.ts";
import type { Completion, LineError, ParsedLine, Result } from "../commands/index.ts";
import type { PortNo, ReadStore, SessionId, Source, UiEvent } from "../model/index.ts";

/**
 * Everything an element may touch, handed down from <unlab-app> through Lit
 * context. Elements read the store and record UI facts; every change to the
 * lab goes through a command line, so a button, the bar and the agent share
 * one parser, one validator and one log.
 */
export interface AppServices {
	readonly store: ReadStore & { dispatchUi(event: UiEvent): void };
	readonly commands: CommandService;
	readonly capture: CaptureView;
	readonly switch: SwitchReadout;
	readonly terminals: TerminalService;
}

export interface CommandService {
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

/** Live figures the switch owns; read on render, never copied into state. */
export interface SwitchReadout {
	counters(port: PortNo): { readonly rxFrames: number; readonly txFrames: number } | undefined;
	macTable(): readonly {
		readonly mac: string;
		readonly port: PortNo;
		readonly seen: number;
		readonly flushed: boolean;
	}[];
	/** The switch clock, for `seen 1 s ago`. */
	now(): number;
}

/** One terminal screen per session, owned by the runtime. Panes never move, so a host mounts once. */
export interface TerminalHost {
	mount(element: HTMLElement): void;
	setVisible(visible: boolean): void;
	setFocused(focused: boolean): void;
	focus(): void;
	/** Rows to draw a gutter rule beside, resolved now. */
	marks(): readonly { readonly fromRow: number; readonly toRow: number; readonly source: "bar" | "agent" }[];
	/** Fires after each render, so the gutter can follow scrolling and new output. */
	onRender(listener: () => void): () => void;
}

export interface TerminalService {
	host(session: SessionId): TerminalHost | null;
}
