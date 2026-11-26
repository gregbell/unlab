// What a running CLI is: the link with the lab, the machines' relay, the ports
// it forwards, and a socket in its own directory that its prompt, `ssh` and other
// runs of the CLI talk to. Only the person it runs as can open that socket.

import { rmSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import type { Asking, LinkedMachine, RemoteResult, Stream } from "../../src/streams/index.ts";
import { Forwards } from "./forwards.ts";
import { type SshFiles, socketPath, sshFiles } from "./keys.ts";
import { type Connection, joinSocket, Relay } from "./relay.ts";
import { type Completion, LinkServer } from "./server.ts";

export interface CoreOptions {
	readonly port: number;
	readonly origins: readonly string[];
	readonly lan: boolean;
	readonly log: boolean;
	/** The command that runs this program, for `ssh` to run. */
	readonly command: readonly string[];
}

export interface Status {
	readonly linked: boolean;
	readonly lan: boolean;
	readonly machines: readonly LinkedMachine[];
	readonly connections: readonly Connection[];
	readonly forwards: readonly { readonly machine: string; readonly local: number; readonly remote: number }[];
}

/** One request to a running CLI, the first line of its connection. */
export type Request =
	| { readonly type: "status" }
	/** Answers once the lab is linked, with null, or with why one that came was refused. */
	| { readonly type: "wait"; readonly ms: number }
	| { readonly type: "run"; readonly line: string }
	| { readonly type: "complete"; readonly line: string; readonly caret: number }
	/** From `ssh`. Once answered, the rest of the connection is the machine's SSH server. */
	| { readonly type: "ssh"; readonly machine: string }
	| { readonly type: "forward"; readonly machine: string; readonly local: number; readonly remote: number }
	| { readonly type: "unforward"; readonly local: number }
	/** Notices, until it is closed. */
	| { readonly type: "watch" };

export type Reply =
	| { readonly type: "ok"; readonly value: unknown }
	| { readonly type: "error"; readonly message: string }
	| { readonly type: "ask"; readonly asking: Asking }
	| { readonly type: "notice"; readonly notice: Notice };

export type Notice =
	| { readonly kind: "linked"; readonly machines: readonly LinkedMachine[] }
	| { readonly kind: "unlinked" }
	| { readonly kind: "refused"; readonly message: string }
	| { readonly kind: "ready"; readonly machines: readonly string[] }
	| { readonly kind: "connection"; readonly text: string };

/** The lines of a socket. One that answers with a function is the last, and the function has the rest of the socket. */
export function onLines(socket: Socket, line: (text: string) => "more" | (() => void)): void {
	let held = Buffer.alloc(0);
	const read = (bytes: Buffer) => {
		held = Buffer.concat([held, bytes]);
		for (let end = held.indexOf(10); end >= 0; end = held.indexOf(10)) {
			const text = held.subarray(0, end).toString();
			held = held.subarray(end + 1);
			const next = line(text);
			if (next !== "more") {
				socket.off("data", read);
				socket.pause();
				if (held.length > 0) socket.unshift(held);
				next();
				return;
			}
		}
	};
	socket.on("data", read);
}

/** How long a single command that started the CLI waits for no one to come before it ends it. */
const QUIET_MS = 1500;

const sentence = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class Core {
	readonly #options: CoreOptions;
	readonly #server: LinkServer;
	readonly #relay: Relay;
	readonly #forwards: Forwards;
	readonly #files: SshFiles;
	readonly #watching = new Set<Socket>();
	/** Every connection to the socket: the prompt's, ssh's, other runs of the CLI. */
	readonly #clients = new Set<Socket>();
	#idle: (() => void) | undefined;
	/** How many have ever connected, so that one that came and went is seen. */
	#connections = 0;
	#port = 0;
	#states = new Map<string, string>();
	#local: Server | undefined;

	constructor(options: CoreOptions) {
		this.#options = options;
		this.#files = sshFiles(options.command);
		this.#relay = new Relay({
			lan: options.lan,
			ownPort: () => this.#port,
			opened: (connection, name) => {
				if (!options.log) return;
				const { machine, host, port } = connection;
				this.#notice({ kind: "connection", text: `${machine} → ${name ? `${name} (${host})` : host}:${port}` });
			},
		});
		this.#server = new LinkServer({
			origins: options.origins,
			on: {
				linked: (linked) => {
					if (linked) this.#notice({ kind: "linked", machines: this.#server.machines });
					else {
						this.#states.clear();
						this.#notice({ kind: "unlinked" });
					}
				},
				machines: (machines) => this.#machinesNow(machines),
				refused: (message) => this.#notice({ kind: "refused", message }),
				asked: (machine, asked) => void this.#relay.asked(machine, asked),
			},
		});
		this.#forwards = new Forwards((machine, port) => this.#server.port(machine, port));
	}

	/** Rejects with EADDRINUSE when another program has the port. */
	async start(): Promise<void> {
		this.#port = await this.#server.listen(this.#options.port);
		try {
			await this.#listen();
		} catch (error) {
			this.#server.close();
			throw error;
		}
	}

	get port(): number {
		return this.#port;
	}

	stop(): void {
		this.#forwards.close();
		this.#server.close();
		for (const socket of this.#watching) socket.destroy();
		this.#local?.close();
		rmSync(socketPath(), { force: true });
	}

	async #listen(): Promise<void> {
		// A CLI that was killed leaves its socket. Nobody answers on it: the caller has tried.
		rmSync(socketPath(), { force: true });
		const local = createServer({ allowHalfOpen: true }, (socket) => this.#came(socket));
		this.#local = local;
		await new Promise<void>((resolve, reject) => {
			local.once("error", reject);
			local.listen(socketPath(), resolve);
		});
	}

	#machinesNow(machines: readonly LinkedMachine[]): void {
		const ready: string[] = [];
		const states = new Map<string, string>();
		for (const { name, state } of machines) {
			states.set(name, state);
			const before = this.#states.get(name);
			if (before !== undefined && before !== "ready" && state === "ready") ready.push(name);
		}
		this.#forwards.keep((machine) => states.has(machine));
		this.#states = states;
		if (ready.length > 0) this.#notice({ kind: "ready", machines: ready });
	}

	#notice(notice: Notice): void {
		for (const socket of this.#watching)
			socket.write(`${JSON.stringify({ type: "notice", notice } satisfies Reply)}\n`);
	}

	#status(): Status {
		return {
			linked: this.#server.linked,
			lan: this.#options.lan,
			machines: this.#server.machines,
			connections: [...this.#relay.open],
			forwards: this.#forwards.list(),
		};
	}

	/**
	 * Resolves once nothing is connected to the socket, and nothing new can be:
	 * a single command that started the CLI ends it then, and not under the
	 * feet of another that came meanwhile. One that comes later starts its own.
	 */
	async idle(): Promise<void> {
		const none = () =>
			this.#clients.size === 0
				? Promise.resolve()
				: new Promise<void>((resolve) => {
						this.#idle = resolve;
					});
		// A connection the system has taken is told only a moment later, and closing would reset it.
		for (let came = -1; came !== this.#connections; ) {
			await none();
			came = this.#connections;
			await new Promise((resolve) => setTimeout(resolve, QUIET_MS));
		}
		await new Promise((resolve) => this.#local?.close(resolve) ?? resolve(null));
		rmSync(socketPath(), { force: true });
		await none();
	}

	#came(socket: Socket): void {
		this.#connections++;
		this.#clients.add(socket);
		socket.once("close", () => {
			this.#clients.delete(socket);
			if (this.#clients.size === 0) this.#idle?.();
		});
		const say = (reply: Reply) => socket.write(`${JSON.stringify(reply)}\n`);
		const done = (value: unknown = null) => {
			say({ type: "ok", value });
			socket.end();
		};
		const failed = (error: unknown) => {
			say({ type: "error", message: sentence(error) });
			socket.end();
		};
		socket.on("error", () => socket.destroy());
		let answer: ((yes: boolean) => void) | undefined;
		let asked = false;
		onLines(socket, (text) => {
			if (asked) {
				answer?.(text === "yes");
				return "more";
			}
			asked = true;
			const request = JSON.parse(text) as Request;
			if (request.type === "ssh") {
				return () => this.#ssh(request.machine, socket, say, failed);
			}
			const left = new AbortController();
			socket.once("end", () => left.abort());
			socket.once("close", () => left.abort());
			const ask = (asking: Asking) =>
				new Promise<boolean>((resolve) => {
					answer = resolve;
					left.signal.addEventListener("abort", () => resolve(false), { once: true });
					say({ type: "ask", asking });
				});
			this.#answer(request, socket, ask, left.signal).then((value) => {
				if (request.type !== "watch") done(value);
			}, failed);
			return "more";
		});
	}

	async #answer(
		request: Exclude<Request, { type: "ssh" }>,
		socket: Socket,
		ask: (asking: Asking) => Promise<boolean>,
		signal: AbortSignal,
	): Promise<Status | RemoteResult | Completion | string | null> {
		switch (request.type) {
			case "status":
				return this.#status();
			case "wait":
				return this.#server.whenLinked(request.ms);
			case "run":
				return this.#server.run(request.line, ask, signal);
			case "complete":
				return this.#server.complete(request.line, request.caret);
			case "forward":
				await this.#forwards.add(request.machine, request.local, request.remote, this.#server.machines);
				return this.#status();
			case "unforward":
				this.#forwards.remove(request.local);
				return this.#status();
			case "watch":
				this.#watching.add(socket);
				socket.once("close", () => this.#watching.delete(socket));
				return null;
		}
	}

	#ssh(machine: string, socket: Socket, say: (reply: Reply) => void, failed: (error: unknown) => void): void {
		this.#server.ssh(machine, this.#files.keys).then((stream: Stream) => {
			say({ type: "ok", value: null });
			joinSocket(socket, stream);
			socket.resume();
		}, failed);
	}

	get sshConfig(): string {
		return this.#files.config;
	}
}

/** Nobody answers on the socket: no CLI runs. */
export class NotRunning extends Error {
	override readonly name = "NotRunning";
}

function open(path = socketPath()): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const socket = connect({ path, allowHalfOpen: true });
		socket.once("connect", () => resolve(socket));
		socket.once("error", (error: NodeJS.ErrnoException) => {
			reject(["ENOENT", "ECONNREFUSED"].includes(error.code ?? "") ? new NotRunning("The CLI is not running.") : error);
		});
	});
}

export interface AskOptions {
	/** Left out, every question is answered no. */
	readonly ask?: (asking: Asking) => Promise<boolean>;
	readonly signal?: AbortSignal;
}

/** Ask the running CLI. Rejects with NotRunning, or with its sentence. */
export async function request<T>(
	what: Exclude<Request, { type: "ssh" | "watch" }>,
	options: AskOptions = {},
): Promise<T> {
	const socket = await open();
	const { signal } = options;
	const abort = () => socket.destroy();
	signal?.addEventListener("abort", abort, { once: true });
	return new Promise<T>((resolve, reject) => {
		socket.on("error", reject);
		socket.on("close", () =>
			reject(signal?.aborted ? signal.reason : new NotRunning("The CLI quit before it answered.")),
		);
		onLines(socket, (text) => {
			const reply = JSON.parse(text) as Reply;
			if (reply.type === "ask") {
				void (options.ask?.(reply.asking) ?? Promise.resolve(false)).then((yes) =>
					socket.write(yes ? "yes\n" : "no\n"),
				);
				return "more";
			}
			if (reply.type === "ok") resolve(reply.value as T);
			else if (reply.type === "error") reject(new Error(reply.message));
			socket.end();
			return "more";
		});
		socket.write(`${JSON.stringify(what)}\n`);
	}).finally(() => signal?.removeEventListener("abort", abort));
}

/** Notices from the running CLI. Returns what ends it. `gone` when the CLI quits. */
export async function watch(on: (notice: Notice) => void, gone: () => void): Promise<() => void> {
	const socket = await open();
	let ended = false;
	socket.on("error", () => socket.destroy());
	socket.on("close", () => {
		if (!ended) gone();
	});
	socket.on("end", () => socket.destroy());
	onLines(socket, (text) => {
		const reply = JSON.parse(text) as Reply;
		if (reply.type === "notice") on(reply.notice);
		return "more";
	});
	socket.write(`${JSON.stringify({ type: "watch" } satisfies Request)}\n`);
	return () => {
		ended = true;
		socket.destroy();
	};
}

/** What `ssh` runs: its stdin and stdout become a machine's SSH server. */
export async function proxy(host: string, path?: string): Promise<void> {
	const socket = await open(path);
	const machine = host.replace(/\.unlab$/, "");
	await new Promise<void>((resolve, reject) => {
		socket.on("error", reject);
		onLines(socket, (text) => {
			const reply = JSON.parse(text) as Reply;
			if (reply.type === "error") {
				return () => reject(new Error(reply.message));
			}
			return () => {
				process.stdin.pipe(socket);
				socket.pipe(process.stdout);
				socket.once("close", resolve);
			};
		});
		socket.write(`${JSON.stringify({ type: "ssh", machine } satisfies Request)}\n`);
	});
}
