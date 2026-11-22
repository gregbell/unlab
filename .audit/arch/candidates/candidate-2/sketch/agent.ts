// src/agent/* — WebMCP. Tools are derived from REGISTRY (+ two ReadTools);
// registration is reconciled from AgentState, like the kernels are.

import type { AnyCommand, Env, LineError, ReadTool } from './commands.ts';
import type { Policy } from './domain.ts';

/** The browser's shape, detected on document.modelContext then navigator.modelContext. */
interface ModelContext {
  registerTool(tool: WebMcpTool, opts: { signal: AbortSignal }): void;
}
interface WebMcpTool {
  name: string;
  description: string;
  inputSchema: object;
  annotations?: object;
  execute(input: unknown, opts: { signal: AbortSignal }): Promise<unknown>;
}

/** null when the browser has no WebMCP: the agent indicator and panel still render, saying so. */
export function detectModelContext(): ModelContext | null { throw new Error('not implemented'); }

/**
 * One tool's execute, the whole agent path:
 *   1. dispatch agent-call (marks agent active; firstCallAt)
 *   2. args = binding.fromInput(input, state)  → LineError? return its message
 *   3. err  = command.validate(args, state)    → return err.message + ' Nothing was changed.'
 *   4. policy 'ask' → dispatch agent-pending { line: format(args), preview: preview(args).will,
 *      actionLabel: actionLabel(args) }; await Approvals.wait(id, signal)
 *      (signal abort → dispatch agent-settled 'aborted'; the block disappears)
 *      Denied → return 'Denied by the user.'
 *   5. result = invoke(command, args, { source: 'agent', signal, env })   — the same path as the bar
 *   6. dispatch agent-settled; return result.data (or the LineError message)
 */
export function toolFor(c: AnyCommand, env: Env, approvals: Approvals): WebMcpTool { throw new Error('not implemented'); }
export function readToolFor(t: ReadTool, env: Env): WebMcpTool { throw new Error('not implemented'); }

/**
 * Resolvers for pending calls. Functions cannot live in LabState, so this map
 * holds them by PendingCall.id; the state holds everything visible. The
 * approval block's buttons call settle(); nothing else does. Enter approves
 * only because the button has focus (no global shortcut).
 */
export interface Approvals {
  wait(id: number, signal: AbortSignal): Promise<'allow' | 'deny'>;
  settle(id: number, answer: 'allow' | 'deny'): void;
}
export function createApprovals(): Approvals { throw new Error('not implemented'); }

/**
 * Subscribes to agent.policies and agent.paused. Desired registered set =
 * tools whose policy != 'off' and !paused; one AbortController per
 * registered tool; abort to unregister. Idempotent on every flush.
 */
export function startAgent(env: Env, mc: ModelContext | null, tools: readonly WebMcpTool[], policyOf: (tool: string) => Policy): () => void {
  throw new Error('not implemented');
}

/** 'no agent calls yet' | 'agent active' (lastCallAt within 5 min of now) | 'agent idle'. Pure. */
export function agentWording(lastCallAt: number | null, now: number, paused: boolean): string { throw new Error('not implemented'); }

export type { LineError };
