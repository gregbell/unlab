// src/commands/* — one registry. Bar, button and agent all end in `invoke`,
// which is the only function that calls `command.run`.

import type { LabState, Machine, MachineName, PendingCall, Source } from './domain.ts';
import { planSpawn, resolveTargets } from './domain.ts';
import type { Runtime } from './runtime.ts';
import type { Store } from './store.ts';

// ───────────────────────── contract (HANDOFF "Components", adjusted) ─────────────────────────

/** A token keeps its position so errors can put carets under it. */
export interface Token { readonly text: string; readonly start: number; readonly end: number }
/** `verb targets args --opts [-- passthrough]`; tokens[0] is the verb. */
export interface Line { readonly raw: string; readonly tokens: readonly Token[]; readonly rest: string | null }

export interface LineError {
  readonly message: string;
  /** Index into line.tokens. Absent for agent input and run-time failures. */
  readonly token?: number;
  /** The whole repaired line, when one edit fixes it. */
  readonly fix?: string;
}

export interface Suggestion {
  readonly insert: string;
  readonly label: string;
  readonly detail?: string;
  readonly hue?: Machine['hue'];
}

export interface Env {
  readonly store: Store;
  readonly runtime: Runtime;
}

export interface RunCtx {
  readonly source: Source;
  readonly signal: AbortSignal;
  readonly env: Env;
}

/** What the bar shows after a run, and what an agent tool returns. */
export interface Result {
  /** Log + recent summary: `booted node4, node5`. */
  readonly summary: string;
  /** Close the bar (effect visible in the lab) or keep it open on `blocks`. */
  readonly close: boolean;
  readonly blocks?: readonly ResultBlock[];
  /** Structured output for the WebMCP tool. */
  readonly data: unknown;
}
export type ResultBlock =
  | { kind: 'header'; text: string }
  | { kind: 'machine'; machine: MachineName; exitCode: number | null; lastLine: string }
  | { kind: 'skipped'; machine: MachineName; reason: string }
  | { kind: 'table'; rows: readonly string[][] };

export interface AgentBinding<Args> {
  readonly tool: string; // 'machines_spawn'
  readonly description: string;
  readonly inputSchema: object;
  readonly annotations?: { readOnlyHint?: boolean; consequentialHint?: boolean; untrustedContentHint?: boolean };
  readonly defaultPolicy: 'run' | 'ask';
  /** Input from the agent, checked by hand: the browser is not trusted to apply the schema. */
  fromInput(input: unknown, s: LabState): Args | LineError;
}

export interface Command<Args> {
  readonly name: string;
  readonly signature: readonly string[];
  readonly danger: boolean;
  parse(line: Line, s: LabState): Args | LineError;
  complete(line: Line, cursorToken: number, s: LabState): Suggestion[];
  validate(args: Args, s: LabState): LineError | null;
  /** `will …` line(s). Shared verbatim by the bar preview and the approval block. */
  preview(args: Args, s: LabState): { will: string; assumed: string | null };
  /** Bar-grammar rendering of args. Agent calls are logged and shown in `recent` with this. */
  format(args: Args): string;
  /** Primary-button label in confirm/approval: `Remove node3`. */
  actionLabel(args: Args): string;
  /** Confirm question for danger commands: names the machine, what is lost, who else is affected. */
  confirm?(args: Args, s: LabState): string;
  run(args: Args, ctx: RunCtx): Promise<Result>;
  readonly agent?: AgentBinding<Args>;
}

/** Existential wrapper so the registry is one homogeneous list without `any`. */
export interface AnyCommand { use<R>(f: <A>(c: Command<A>) => R): R }
export function defineCommand<A>(c: Command<A>): AnyCommand { return { use: (f) => f(c) }; }

// ───────────────────────── the one run path ─────────────────────────

/**
 * Re-validates against the state *now* (a preview or approval may be stale),
 * logs start with source and bar-grammar line, runs, logs the outcome.
 * Throws nothing: run-time failures come back as LineError, in the same block.
 * Confirmation is NOT here: it is a surface concern (bar: second Enter;
 * agent: policy; button: the details panel shows the same confirm part
 * inline, built from command.confirm/actionLabel, then calls press()).
 */
export function invoke<A>(c: Command<A>, args: A, ctx: RunCtx): Promise<Result | LineError> { throw new Error('not implemented'); }

export function tokenize(raw: string): Line { throw new Error('not implemented'); }
/** Registry lookup + parse + validate, for the bar model. */
export function interpret(raw: string, s: LabState): { kind: 'empty' } | { kind: 'error'; error: LineError; line: Line } | { kind: 'ok'; line: Line; use: AnyCommand; args: unknown } {
  throw new Error('not implemented');
}

// ───────────────────────── verbs (four sketched in full shape) ─────────────────────────

interface SpawnArgs { count: number; image: string; memMiB: number; net: boolean; assumed: readonly string[] }
const formatSpawn = (a: SpawnArgs): string => `spawn ${a.count} ${a.image} --mem ${a.memMiB} ${a.net ? '--net switch0' : '--no-net'}`;

export const spawn = defineCommand<SpawnArgs>({
  name: 'spawn',
  signature: ['<count>', '<image>', '[--mem MiB]', '[--net switch0 | --no-net]'],
  danger: false,
  parse(line, s) {
    // TODO: tokens[1] integer ≥ 1 else {message:'spawn wants a count here, not x.', token:1}
    //       tokens[2] ∈ s.images else nearest image by edit distance → fix
    //       options: --mem <int>, --net switch0, --no-net; unknown → nearest option → fix
    //       assumed = options not given, rendered '--mem 256', '--net switch0'
    throw new Error('not implemented');
  },
  complete(line, at, s) { throw new Error('not implemented'); },
  validate(a, s) {
    const plan = planSpawn(s, a.count, a.image, a.memMiB, a.net);
    if ('short' in plan) {
      return plan.short === 'ports'
        ? { message: `switch0 has ${plan.free} free ports. Add --no-net to boot them unplugged.`, fix: formatSpawn({ ...a, net: false }) }
        : { message: `The lab holds 8 machines and has room for ${plan.free}.` };
    }
    return null;
  },
  preview(a, s) {
    // Same allocator as the reducer: these names and ports are the ones it will take.
    // TODO: 'will boot node4 and node5 · alpine · 256 MiB · ports 4 and 5'
    throw new Error('not implemented');
  },
  format: formatSpawn,
  actionLabel: (a) => (a.count === 1 ? 'Boot 1 machine' : `Boot ${a.count} machines`),
  async run(a, { env, source }) {
    const plan = planSpawn(env.store.state, a.count, a.image, a.memMiB, a.net);
    if ('short' in plan) throw new Error('unreachable: invoke re-validated');
    env.store.dispatch({ type: 'spawn', plan, source });
    // The reconciler starts the workers at the next flush. The rows and panes
    // are the visible effect, so the bar closes now; each boots on its own.
    const names = plan.machines.map((m) => m.name);
    return { summary: `booting ${names.join(', ')}`, close: true, data: { names } };
  },
  agent: {
    tool: 'machines_spawn',
    description: 'Boot new Linux machines on the lab switch.',
    inputSchema: { type: 'object', properties: { count: { type: 'integer' }, image: { type: 'string' }, mem: { type: 'integer' }, net: { enum: ['switch0', 'none'] } }, required: ['count', 'image'] },
    defaultPolicy: 'ask',
    fromInput(input, s) { throw new Error('not implemented'); },
  },
});

interface RmArgs { machines: readonly MachineName[] }

export const rm = defineCommand<RmArgs>({
  name: 'rm',
  signature: ['<machines>'],
  danger: true,
  parse(line, s) { throw new Error('not implemented'); },
  complete(line, at, s) { throw new Error('not implemented'); },
  validate(a, s) {
    // TODO: each name exists and is not removing; 'No machine called node7. You have node1, node2, node3.'
    throw new Error('not implemented');
  },
  preview: (a) => ({ will: `will remove ${a.machines.join(', ')} and their disks`, assumed: null }),
  confirm(a, s) {
    // TODO: 'Remove node3? Its disk and 2 open shells go with it. node1 and node2 lose their neighbour on switch0.'
    throw new Error('not implemented');
  },
  format: (a) => `rm ${a.machines.join(',')}`,
  actionLabel: (a) => `Remove ${a.machines.join(', ')}`,
  async run(a, { env, source, signal }) {
    env.store.dispatch({ type: 'remove', machines: a.machines, source });
    // Idempotent: a second rm of a removing machine is a no-op in reduce, and
    // this await resolves at once if they are already gone.
    await env.store.until((s) => a.machines.every((n) => !s.machines.has(n)), signal);
    return { summary: `removed ${a.machines.join(', ')}`, close: true, data: { removed: a.machines } };
  },
  agent: {
    tool: 'machines_remove',
    description: 'Remove machines and their disks.',
    inputSchema: { type: 'object', properties: { names: { type: 'array', items: { type: 'string' } } }, required: ['names'] },
    annotations: { consequentialHint: true },
    defaultPolicy: 'ask',
    fromInput(input, s) { throw new Error('not implemented'); },
  },
});

interface LinkArgs { up: boolean; machines: readonly MachineName[]; skipped: readonly { name: MachineName; reason: string }[] }

export const link = defineCommand<LinkArgs>({
  name: 'link',
  signature: ['<up | down>', '<machines>'],
  danger: false,
  parse(line, s) {
    // TODO: tokens[1] ∈ {up,down} else {message:`link wants up or down here, not ${t}.`, token:1, fix: nearest}
    //       tokens[2] via resolveTargets(expr, s, m => m.life.phase === 'ready' ? null : 'still booting')
    throw new Error('not implemented');
  },
  complete(line, at, s) { throw new Error('not implemented'); },
  validate(a, s) {
    // TODO: `link up` on unplugged needs a free port: 'switch0 has no free ports.'
    throw new Error('not implemented');
  },
  preview(a, s) { throw new Error('not implemented'); }, // 'will cut the cable from node3 to port 3'
  format: (a) => `link ${a.up ? 'up' : 'down'} ${a.machines.join(',')}`,
  actionLabel: (a) => (a.up ? 'Reconnect' : 'Cut') + ` ${a.machines.join(', ')}`,
  async run(a, { env, source }) {
    env.store.dispatch({ type: 'cable', machines: a.machines, cable: a.up ? 'up' : 'cut', source });
    // Reducer assigns ports for unplugged machines; the reconciler applies the
    // switch change and writes the capture event row at the next flush.
    const s = env.store.state;
    const data = a.machines.map((n) => ({ machine: n, port: s.machines.get(n)?.net.port ?? null, link: a.up ? 'up' : 'cut' }));
    return { summary: `${a.up ? 'reconnected' : 'cut'} ${a.machines.join(', ')}`, close: true, data };
  },
  agent: {
    tool: 'link_set',
    description: 'Plug in or cut the cables of machines.',
    inputSchema: { type: 'object', properties: { machines: { type: 'string' }, state: { enum: ['up', 'down'] } }, required: ['machines', 'state'] },
    defaultPolicy: 'run',
    fromInput(input, s) { throw new Error('not implemented'); },
  },
});

interface ExecArgs { targets: readonly { machine: MachineName; session: import('./domain.ts').SessionId }[]; skipped: readonly { name: MachineName; reason: string }[]; command: string }

export const exec = defineCommand<ExecArgs>({
  name: 'exec',
  signature: ['<machines>', '--', '<command>'],
  danger: false,
  parse(line, s) {
    // TODO: tokens[1] targets (machine → its activeSession, or node2:sh1); line.rest required:
    //       'exec wants a command after --.'
    throw new Error('not implemented');
  },
  complete(line, at, s) { throw new Error('not implemented'); },
  validate(a, s) { throw new Error('not implemented'); },
  preview: (a) => ({ will: `will type \`${a.command}\` into ${a.targets.map((t) => t.session).join(', ')}`, assumed: null }),
  format: (a) => `exec ${a.targets.map((t) => t.session).join(',')} -- ${a.command}`,
  actionLabel: (a) => `Run in ${a.targets.length} consoles`,
  async run(a, { env, source, signal }) {
    const t0 = performance.now();
    const outcomes = await Promise.all(a.targets.map((t) => env.runtime.execInSession(t.session, a.command, source, signal)));
    const failed = outcomes.filter((o) => o.exitCode !== 0).length;
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    const blocks: ResultBlock[] = [
      { kind: 'header', text: `ran in ${a.targets.length} consoles in ${secs} s${failed ? ` · ${failed} failed` : ''}` },
      ...a.targets.map((t, i): ResultBlock => ({ kind: 'machine', machine: t.machine, exitCode: outcomes[i].exitCode, lastLine: lastLine(outcomes[i].output) })),
      ...a.skipped.map((k): ResultBlock => ({ kind: 'skipped', machine: k.name, reason: k.reason })),
    ];
    return { summary: blocks[0].kind === 'header' ? blocks[0].text : '', close: false, blocks, data: a.targets.map((t, i) => ({ session: t.session, ...outcomes[i] })) };
  },
  agent: {
    tool: 'shell_exec',
    description: "Run a shell command in a machine's active session; it is typed into the visible console.",
    inputSchema: { type: 'object', properties: { target: { type: 'string' }, command: { type: 'string' } }, required: ['target', 'command'] },
    annotations: { untrustedContentHint: true },
    defaultPolicy: 'run',
    fromInput(input, s) { throw new Error('not implemented'); },
  },
});

declare function lastLine(s: string): string;

/** The one list. Bar verbs, completion of verbs, and agent tools derive from it. */
export const REGISTRY: readonly AnyCommand[] = [spawn, rm, /* ls, */ exec, /* sh, */ link /* , capture, focus */];

// ───────────────────────── surfaces ─────────────────────────

/** Button: build args directly, same invoke. */
export function press<A>(c: Command<A>, args: A, env: Env): Promise<Result | LineError> {
  return invoke(c, args, { source: 'button', signal: AbortSignal.timeout(120_000), env });
}

/** Read-only agent tools with no bar verb (shell_read, capture_read). */
export interface ReadTool {
  readonly tool: string;
  readonly description: string;
  readonly inputSchema: object;
  readonly annotations: { readOnlyHint: true; untrustedContentHint?: boolean };
  read(input: unknown, env: Env): string | LineError;
}

export type ApprovalRequest = Omit<PendingCall, 'id'>;
