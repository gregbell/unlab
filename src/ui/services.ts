import type { CaptureView } from "../capture/index.ts";
import type { CommandService } from "../commands/index.ts";
import type { PortNo, ReadStore, SessionId, ToolName, UiEvent } from "../model/index.ts";

export type { CommandService };

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
	readonly agent: AgentService;
}

/** The WebMCP side the agent panel needs beyond the store: the tool list, the person's answer to a waiting call, and a call of their own. */
export interface AgentService {
	/** In the panel's order, with each tool's argument names. */
	readonly tools: readonly { readonly name: ToolName; readonly args: readonly string[] }[];
	/** Allow or Deny. Only a waiting call listens. */
	answer(call: number, allow: boolean): void;
	/** Calls machines_list through the browser, as an agent would. Null where a page cannot call tools. */
	readonly tryCall: (() => Promise<void>) | null;
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
