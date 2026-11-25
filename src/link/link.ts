// The page's end of the link with the CLI. It dials a program on this computer,
// which the browser asks the person about, so it dials only once the person has
// asked for it: from here, or by opening the lab from the CLI. After that it
// dials by itself whenever the CLI is there.

import { grantApproval } from "../commands/approval.ts";
import {
	completeLine,
	type ExecData,
	isLineError,
	NOTHING_CHANGED,
	parseLine,
	type Registry,
	type ReportBlock,
	type Result,
} from "../commands/index.ts";
import { type CliLink, type LabState, machineList, type Store } from "../model/index.ts";
import {
	type Asking,
	FIRST_LINK_PORT,
	type FromCli,
	type FromLab,
	LAB_PATH,
	LINK_PORT,
	type LinkedMachine,
	PROTOCOL,
	type RemoteBlock,
	type RemoteResult,
} from "../streams/index.ts";

/** As much of a WebSocket as this uses. */
export interface LinkSocket {
	send(text: string): void;
	close(): void;
	onopen: (() => void) | null;
	onmessage: ((event: { readonly data: unknown }) => void) | null;
	onclose: (() => void) | null;
}

/** Whether the lab dials, and where. Kept for the next time the page is opened. */
export interface LinkMemory {
	readonly on: boolean;
	readonly port: number;
}

export interface LinkDeps {
	readonly store: Pick<Store, "state" | "subscribe" | "dispatchLink">;
	readonly registry: Registry;
	dial(url: string): LinkSocket;
	readonly memory: { read(): LinkMemory; write(memory: LinkMemory): void };
	/** Runs fn about once a second, however hidden the page is, until the returned function is called. */
	everySecond(fn: () => void): () => void;
	/** Whether the person lets this page reach programs on this computer. */
	permission(): Promise<PermissionState | null>;
	/** Where the machines' workers dial, or null when there is no link. */
	machines(target: { readonly url: string; readonly token: string } | null): void;
}

export interface Link {
	/** The person's word. A port from the CLI that opened the page is kept with it. */
	set(on: boolean, port?: number): void;
	dispose(): void;
}

export const FORGOTTEN: LinkMemory = { on: false, port: LINK_PORT };

const STATUS = {
	exit: (code: number) => `exit ${code}`,
	skipped: (reason: string) => `skipped: ${reason}`,
} as const;

function statusText({ status }: ReportBlock): string {
	switch (status.kind) {
		case "exit":
			return STATUS.exit(status.code);
		case "unknown":
			return "exit ?";
		case "skipped":
			return STATUS.skipped(status.reason);
		case "state":
			return status.text;
	}
}

function isExecData(data: unknown): data is ExecData {
	return typeof data === "object" && data !== null && "ran" in data && Array.isArray(data.ran);
}

/** A result as it goes over the link: the bar's, and the agent tool's reply. */
export function remoteResult(result: Result): RemoteResult {
	if (result.kind === "failed") return { ok: false, message: result.error.message, fix: result.error.fix ?? null };
	if (result.kind === "visible") {
		return { ok: true, text: result.text, blocks: [], rows: [], reply: { result: result.text, data: result.data } };
	}
	// exec's blocks start with one for each session that ran it, in the same order.
	const ran = isExecData(result.data) ? result.data.ran : [];
	const blocks = result.blocks.map((block, i): RemoteBlock => {
		const run = block.status.kind === "exit" || block.status.kind === "unknown" ? ran[i] : undefined;
		return {
			machine: block.machine,
			status: statusText(block),
			exitCode: run?.exitCode ?? null,
			lastLine: block.lastLine,
			output: run?.output ?? null,
		};
	});
	return {
		ok: true,
		text: result.header,
		blocks,
		rows: (result.rows ?? []).map(({ term, text }) => ({ term, text })),
		reply: { result: result.header, data: result.data },
	};
}

function linkedMachines(state: LabState): readonly LinkedMachine[] {
	return machineList(state).map(({ n, name, spec, life }) => ({ n, name, image: spec.image, state: life.phase }));
}

export function startLink(deps: LinkDeps): Link {
	const { store, registry } = deps;
	let memory = deps.memory.read();
	let socket: LinkSocket | undefined;
	let linked = false;
	/** It answered that it does not take this lab. Dialling goes on, for when it does. */
	let refused: string | null = null;
	let stopClock: (() => void) | undefined;
	let said = "";
	const running = new Map<number, AbortController>();
	const answers = new Map<number, (yes: boolean) => void>();

	const show = (cli: CliLink) => store.dispatchLink({ type: "cli/link", cli });
	const say = (message: FromLab) => socket?.send(JSON.stringify(message));

	const sayMachines = () => {
		if (!linked) return;
		const machines = linkedMachines(store.state);
		const text = JSON.stringify(machines);
		if (text === said) return;
		said = text;
		say({ type: "machines", machines });
	};

	const ask = (id: number, asking: Asking, signal: AbortSignal) =>
		new Promise<boolean>((resolve) => {
			const settle = (yes: boolean) => {
				answers.delete(id);
				resolve(yes);
			};
			answers.set(id, settle);
			signal.addEventListener("abort", () => settle(false), { once: true });
			say({ type: "ask", id, asking });
		});

	async function run(id: number, line: string, signal: AbortSignal): Promise<RemoteResult> {
		const parsed = parseLine(registry, line, store.state);
		if (isLineError(parsed)) return remoteResult({ kind: "failed", error: parsed });
		const invalid = parsed.validate(store.state);
		if (invalid) return remoteResult({ kind: "failed", error: invalid });
		if (!parsed.danger) return remoteResult(await parsed.run({ source: "cli", signal }));
		const asked = parsed.confirm(store.state);
		if (isLineError(asked)) return remoteResult({ kind: "failed", error: asked });
		const { question, detail, actionLabel } = asked;
		if (!(await ask(id, { question, detail, actionLabel }, signal))) {
			return { ok: false, message: `You did not say yes. ${NOTHING_CHANGED}`, fix: null };
		}
		return remoteResult(await parsed.run({ source: "cli", signal, approval: grantApproval(parsed.line, asked) }));
	}

	function heard(message: FromCli): void {
		switch (message.type) {
			case "hello":
				linked = true;
				refused = null;
				said = "";
				show({ kind: "linked" });
				deps.machines({ url: url(), token: message.token });
				sayMachines();
				return;
			case "refused":
				refused = message.message;
				show({ kind: "refused", message: message.message });
				return;
			case "run": {
				const { id, line } = message;
				const abort = new AbortController();
				running.set(id, abort);
				const asking = socket;
				run(id, line, abort.signal)
					.catch((error: unknown): RemoteResult => {
						const stopped = abort.signal.aborted ? "Stopped." : String(error instanceof Error ? error.message : error);
						return { ok: false, message: stopped, fix: null };
					})
					.then((result) => {
						if (running.get(id) === abort) running.delete(id);
						// Another CLI counts its lines anew, and would take this for one of its own.
						if (socket !== asking) return;
						// What the line changed, before its result: what is typed next may need it.
						sayMachines();
						say({ type: "result", id, result });
					});
				return;
			}
			case "answer":
				answers.get(message.id)?.(message.yes);
				return;
			case "abort":
				running.get(message.id)?.abort(new Error("Stopped from the CLI."));
				return;
			case "complete": {
				const { id, line, caret } = message;
				const { replace, suggestions } = completeLine(registry, line, caret, store.state);
				say({
					type: "completion",
					id,
					...replace,
					suggestions: suggestions.map(({ insert, detail }) => ({ insert, detail: detail ?? null })),
				});
				return;
			}
		}
	}

	const url = () => `ws://127.0.0.1:${memory.port}`;

	function left(): void {
		socket = undefined;
		// What runs, runs on. What was not yet said yes to does not.
		for (const answer of [...answers.values()]) answer(false);
		running.clear();
		if (linked) {
			linked = false;
			deps.machines(null);
		}
	}

	async function dial(): Promise<void> {
		if (socket || !memory.on) return;
		const permission = await deps.permission();
		if (socket || !memory.on) return;
		if (permission === "denied") {
			show({ kind: "blocked" });
			return;
		}
		if (refused === null) show({ kind: "waiting" });
		const dialled = deps.dial(url() + LAB_PATH);
		socket = dialled;
		dialled.onopen = () => say({ type: "hello", protocol: PROTOCOL });
		dialled.onmessage = ({ data }) => {
			if (socket === dialled) heard(JSON.parse(String(data)) as FromCli);
		};
		dialled.onclose = () => {
			if (socket !== dialled) return;
			const was = linked;
			left();
			if (was && memory.on) show({ kind: "waiting" });
			else if (!was && refused === null && memory.on) show({ kind: "waiting" });
		};
	}

	function begin(): void {
		stopClock ??= deps.everySecond(() => void dial());
		void dial();
	}

	function hangUp(): void {
		const open = socket;
		left();
		open?.close();
	}

	const unsubscribe = store.subscribe(sayMachines);
	if (memory.on) begin();

	return {
		set(on, port = memory.port) {
			const moved = port !== memory.port;
			memory = { on, port };
			deps.memory.write(memory);
			if (!on || moved) hangUp();
			if (on) {
				begin();
				return;
			}
			refused = null;
			stopClock?.();
			stopClock = undefined;
			show({ kind: "off" });
		},
		dispose() {
			unsubscribe();
			stopClock?.();
			hangUp();
		},
	};
}

/** `#cli=27122`, with the port it listens on, is how the CLI opens the lab. Version 0.1.0 left the port out. Null for anything else. */
export function linkAsked(hash: string): { readonly port: number } | null {
	const match = /^#cli(?:=(\d{1,5}))?$/.exec(hash);
	if (!match) return null;
	const port = match[1] === undefined ? FIRST_LINK_PORT : Number(match[1]);
	return port >= 1 && port <= 65535 ? { port } : null;
}
