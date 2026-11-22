// src/agent/* — WebMCP. Five tools are bindings over verbs, two are read-only
// queries. Every tool call becomes a bar line first, so it goes through the
// same parse/validate/preview/run as a typed line, and it is logged and shown
// in `recent` in bar grammar without a second formatter.

import type { CaptureView } from "./capture.ts";
import type { ExecPort, LineError, Registry, ToolBinding } from "./commands.ts";
import type { AgentControls } from "./ui.ts";
import type { LabState, Policy, Store, ToolName } from "./model.ts";

// ───────────────────────────── the browser API, parsed at the edge ─────────────────────────────

export interface WebMcpTool {
	name: string;
	description: string;
	inputSchema: object;
	annotations?: { readOnlyHint?: boolean; consequentialHint?: boolean; untrustedContentHint?: boolean };
	execute(input: unknown, opts: { signal: AbortSignal }): Promise<unknown>;
}
export interface ModelContextLike {
	registerTool(tool: WebMcpTool, opts: { signal: AbortSignal }): void;
}
/** document.modelContext, else navigator.modelContext (older drafts), else null — and then the agent module does nothing at all. */
export function detectModelContext(doc: Document, nav: Navigator): ModelContextLike | null {
	throw new Error("not implemented");
}

// ───────────────────────────── the tool table: one list, derived ─────────────────────────────

export type ToolEntry =
	| { readonly kind: "command"; readonly binding: ToolBinding<unknown> } // machines_list, machines_spawn, machines_remove, shell_exec, link_set
	| {
			readonly kind: "query"; // shell_read, capture_read
			readonly tool: ToolName;
			readonly description: string;
			readonly inputSchema: object;
			readonly annotations: WebMcpTool["annotations"];
			/** Returns a sentence on bad input, using the same LineError shape as verbs. */
			read(input: unknown, lab: LabState, deps: { exec: ExecPort; capture: CaptureView }): unknown | LineError;
	  };

/** Defaults from the spec: run for everything except spawn and remove (ask). Danger verbs default to ask regardless. */
export declare function toolTable(registry: Registry): Readonly<Record<ToolName, ToolEntry>>;
export declare function defaultPolicies(table: Readonly<Record<ToolName, ToolEntry>>, registry: Registry): Readonly<Record<ToolName, Policy>>;

// ───────────────────────────── the call pipeline ─────────────────────────────

/**
 * execute(input, { signal }) for a command tool:
 *   1. line = binding.toLine(input)                 → LineError? return { error: message }  (call logged as failed)
 *   2. parsed = parseLine(registry, line, lab)      → LineError? same
 *   3. err = command.validate(args, lab)            → same
 *   4. policy === 'ask':
 *        dispatch agent/call { status: 'waiting', preview: command.preview(...).will, actionLabel: confirm?.actionLabel ?? verb-named label }
 *        await answer(id) | signal.abort
 *          deny   → settle 'denied', return 'Denied by the user.'
 *          abort  → settle 'aborted' (the block disappears), rethrow the abort
 *          allow  → approval = grantApproval(line)
 *      policy === 'run' and command.danger → the standing policy is the approval: grantApproval(line)
 *   5. result = await command.run(args, { source: 'agent', signal, approval })   // re-plans against current state
 *   6. settle 'done' | 'failed' with a one-line result; return { text, data } — guest-derived text marked untrusted by annotation
 *
 * Pending answers live in a private Map<callId, (allow: boolean) => void>. The
 * store holds only data (the waiting call, its preview); functions never
 * enter state. Pending calls stack oldest first and never time out.
 */
export interface Agent {
	readonly controls: AgentControls;
	dispose(): void;
}

export interface AgentDeps {
	readonly store: Pick<Store, "state" | "subscribe" | "dispatchAgent">;
	readonly registry: Registry;
	readonly exec: ExecPort;
	readonly capture: CaptureView;
	readonly modelContext: ModelContextLike | null;
	readonly now: () => number;
}

/**
 * Registration is a reconcile, run on every store change and idempotent:
 *   desired = tools with policy !== 'off', or none when agent.paused
 *   for each tool in desired but not registered → registerTool(tool, { signal: new AbortController().signal })
 *   for each registered but not desired         → abort its controller (unregisters)
 * `off` keeps the row in the panel in --text-3; paused reads `webmcp: paused`.
 */
export function createAgent(deps: AgentDeps): Agent {
	throw new Error("not implemented");
}
