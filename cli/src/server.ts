// Where the lab connects to: its page with commands, and each machine's worker
// with streams. It listens on this computer only, and takes only the lab's pages.

import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { type RawData, type WebSocket, WebSocketServer } from "ws";
import {
	type Asked,
	type Asking,
	FEATURES,
	type Feature,
	type FromCli,
	type FromLab,
	LAB_OLDER,
	LAB_PATH,
	type LinkedMachine,
	MACHINE_PATH,
	Mux,
	PROTOCOL,
	type RemoteResult,
	type RemoteSuggestion,
	type SshKeys,
	type Stream,
	type ToolInfo,
	versionRefusal,
} from "../../src/streams/index.ts";

export interface LinkEvents {
	/** The lab is linked, or it is not any more. */
	linked(linked: boolean): void;
	machines(machines: readonly LinkedMachine[]): void;
	/** A lab came that cannot be used. One sentence. */
	refused(message: string): void;
	/** A machine asks for a connection or a name. */
	asked(machine: string, asked: Asked): void;
	/** What an agent may call now. None while no lab is linked. */
	tools(tools: readonly ToolInfo[]): void;
}

export interface LinkServerOptions {
	readonly origins: readonly string[];
	readonly on: LinkEvents;
}

export interface Completion {
	readonly start: number;
	readonly end: number;
	readonly suggestions: readonly RemoteSuggestion[];
}

/** Not linked, or no longer. One sentence. */
export class NotLinked extends Error {
	override readonly name = "NotLinked";
}

const NOT_LINKED = "The lab is not linked. Open it in the browser, and allow it to reach apps on this device.";
/** What an agent is told, which a person reads in its answer. */
const AGENT_NOT_LINKED = "The lab is not linked. Run `npx unlab.run` to open it, and allow the browser's question.";
const CLOSED_DURING_CALL = "The lab closed while this ran. Whether it finished is not known.";
/** How long a machine's worker has to connect once the machine is there. */
const MACHINE_MS = 8000;
/** A lab that does not answer within this is gone. */
const PING_MS = 10_000;

interface Running {
	ask(asking: Asking): Promise<boolean>;
	settle(result: RemoteResult): void;
	fail(error: Error): void;
}

interface Call {
	settle(reply: unknown): void;
	fail(error: Error): void;
}

interface Machine {
	readonly mux: Mux;
	readonly socket: WebSocket;
}

function bytesOf(data: RawData): Uint8Array {
	if (Array.isArray(data)) return Buffer.concat(data);
	return data instanceof ArrayBuffer ? new Uint8Array(data) : data;
}

export class LinkServer {
	readonly #options: LinkServerOptions;
	readonly #http: Server;
	readonly #sockets = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 1 << 22 });
	#lab: WebSocket | undefined;
	#token = "";
	#linked = false;
	#refusal: string | null = null;
	/** The last refusal that was told. A lab that is refused comes again each second. */
	#told: string | null = null;
	#machines: readonly LinkedMachine[] = [];
	#labFeatures: readonly Feature[] = [];
	#tools: readonly ToolInfo[] = [];
	readonly #calls = new Map<number, Call>();
	readonly #channels = new Map<string, Machine>();
	readonly #running = new Map<number, Running>();
	readonly #completing = new Map<number, (completion: Completion) => void>();
	readonly #waiting = new Set<() => void>();
	#ids = 0;

	constructor(options: LinkServerOptions) {
		this.#options = options;
		this.#http = createServer((_, response) => {
			response.writeHead(404, { "content-type": "text/plain" }).end("This is the unlab CLI.\n");
		});
		this.#http.on("upgrade", (request, socket, head) => this.#upgrade(request, socket, head));
	}

	/** Rejects with EADDRINUSE when something else has the port. Returns the one it has. */
	listen(port: number): Promise<number> {
		return new Promise((resolve, reject) => {
			this.#http.once("error", reject);
			this.#http.listen(port, "127.0.0.1", () => {
				this.#http.off("error", reject);
				const address = this.#http.address();
				resolve(typeof address === "object" && address ? address.port : port);
			});
		});
	}

	get linked(): boolean {
		return this.#linked;
	}

	get machines(): readonly LinkedMachine[] {
		return this.#machines;
	}

	get tools(): readonly ToolInfo[] {
		return this.#tools;
	}

	close(): void {
		for (const socket of this.#sockets.clients) socket.terminate();
		this.#http.close();
		this.#http.closeAllConnections();
	}

	/** Null once it is linked, or why a lab that came was refused. Rejects with NotLinked once the time is up. */
	async whenLinked(ms: number): Promise<string | null> {
		this.#refusal = null;
		await this.#until(
			() => this.#linked || this.#refusal !== null,
			ms,
			() => new NotLinked(NOT_LINKED),
		);
		return this.#linked ? null : this.#refusal;
	}

	/** Runs a line in the lab. `ask` answers for a line that asks first. */
	run(line: string, ask: (asking: Asking) => Promise<boolean>, signal?: AbortSignal): Promise<RemoteResult> {
		if (!this.#linked) return Promise.reject(new NotLinked(NOT_LINKED));
		const id = ++this.#ids;
		const running = Promise.withResolvers<RemoteResult>();
		this.#running.set(id, { ask, settle: running.resolve, fail: running.reject });
		const abort = () => this.#say({ type: "abort", id });
		signal?.addEventListener("abort", abort, { once: true });
		this.#say({ type: "run", id, line });
		return running.promise.finally(() => {
			signal?.removeEventListener("abort", abort);
			this.#running.delete(id);
		});
	}

	/** An agent's call of one of the lab's tools. Resolves with what the tool replied; rejects with a sentence. */
	call(name: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
		if (!this.#linked) return Promise.reject(new NotLinked(this.#told ?? AGENT_NOT_LINKED));
		if (!this.#labFeatures.includes("tools")) return Promise.reject(new Error(LAB_OLDER));
		const id = ++this.#ids;
		const calling = Promise.withResolvers<unknown>();
		this.#calls.set(id, { settle: calling.resolve, fail: calling.reject });
		const abort = () => this.#say({ type: "abort", id });
		signal?.addEventListener("abort", abort, { once: true });
		this.#say({ type: "call", id, name, input });
		return calling.promise.finally(() => {
			signal?.removeEventListener("abort", abort);
			this.#calls.delete(id);
		});
	}

	complete(line: string, caret: number): Promise<Completion> {
		const none = { start: caret, end: caret, suggestions: [] };
		if (!this.#linked) return Promise.resolve(none);
		const id = ++this.#ids;
		return new Promise((resolve) => {
			const timer = setTimeout(() => settle(none), 1000);
			const settle = (completion: Completion) => {
				clearTimeout(timer);
				this.#completing.delete(id);
				resolve(completion);
			};
			this.#completing.set(id, settle);
			this.#say({ type: "complete", id, line, caret });
		});
	}

	/** A port in a machine, on its loopback. Rejects with a sentence. */
	port(machine: string, port: number): Promise<Stream> {
		return this.#open(machine, { kind: "port", port });
	}

	ssh(machine: string, keys: SshKeys): Promise<Stream> {
		return this.#open(machine, { kind: "ssh", keys });
	}

	async #open(name: string, to: object): Promise<Stream> {
		if (!this.#linked) throw new NotLinked(NOT_LINKED);
		const refusal = () => {
			const machine = this.#machines.find((m) => m.name === name);
			if (!machine) {
				const names = this.#machines.map((m) => m.name);
				const have = names.length === 0 ? "The lab has no machines yet." : `You have ${names.join(", ")}.`;
				return `No machine called ${name}. ${have}`;
			}
			if (machine.state === "ready") return null;
			if (machine.state === "booting") return `${name} is still booting. Try again once it is ready.`;
			if (machine.state === "off") return `${name} is off. Boot it with: boot ${name}`;
			if (machine.state === "failed") return `${name} did not boot. Try again with: boot ${name}`;
			return `${name} is ${machine.state}, so nothing can connect to it.`;
		};
		const refused = refusal();
		if (refused !== null) throw new Error(refused);
		await this.#until(
			() => this.#channels.has(name) || refusal() !== null,
			MACHINE_MS,
			() => new Error(`${name} did not connect to the CLI. Reload the lab, and try again.`),
		);
		const machine = this.#channels.get(name);
		if (!machine) throw new Error(refusal() ?? NOT_LINKED);
		return machine.mux.open(to);
	}

	#until(ready: () => boolean, ms: number, late: () => Error): Promise<void> {
		if (ready()) return Promise.resolve();
		return new Promise((resolve, reject) => {
			const done = () => {
				clearTimeout(timer);
				this.#waiting.delete(check);
			};
			const timer = setTimeout(() => {
				done();
				reject(late());
			}, ms);
			const check = () => {
				if (!ready()) return;
				done();
				resolve();
			};
			this.#waiting.add(check);
		});
	}

	#changed(): void {
		for (const check of [...this.#waiting]) check();
	}

	#say(message: FromCli, to = this.#lab): void {
		to?.send(JSON.stringify(message));
	}

	#upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
		const url = new URL(request.url ?? "/", "http://localhost");
		const refuse = (status: string) => {
			socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
		};
		// A browser says which page asks, and a page cannot say it is another.
		if (!this.#options.origins.includes(request.headers.origin ?? "")) {
			refuse("403 Forbidden");
			return;
		}
		if (url.pathname === LAB_PATH) {
			this.#sockets.handleUpgrade(request, socket, head, (ws) => this.#labCame(ws));
			return;
		}
		const name = url.searchParams.get("name") ?? "";
		const known = this.#linked && url.searchParams.get("token") === this.#token;
		if (url.pathname !== MACHINE_PATH || !known || name === "") {
			refuse("403 Forbidden");
			return;
		}
		this.#sockets.handleUpgrade(request, socket, head, (ws) => this.#machineCame(name, ws));
	}

	#labCame(ws: WebSocket): void {
		let alive = true;
		const pinging = setInterval(() => {
			if (!alive) {
				ws.terminate();
				return;
			}
			alive = false;
			ws.ping();
		}, PING_MS);
		ws.on("pong", () => {
			alive = true;
		});
		ws.on("error", () => ws.terminate());
		ws.on("close", () => {
			clearInterval(pinging);
			if (this.#lab === ws) this.#labLeft();
		});
		const refuse = (message: string) => {
			this.#say({ type: "refused", message }, ws);
			ws.close();
			this.#refusal = message;
			if (message !== this.#told) this.#options.on.refused(message);
			this.#told = message;
			this.#changed();
		};
		ws.once("message", (data) => {
			const hello = JSON.parse(String(data)) as FromLab;
			if (hello.type !== "hello") {
				ws.close();
				return;
			}
			const refusal = versionRefusal(PROTOCOL, hello.protocol);
			if (refusal !== null) {
				refuse(refusal);
				return;
			}
			if (this.#lab) {
				refuse("Another lab is linked to this CLI. Close that one, or quit the CLI and start it again.");
				return;
			}
			this.#lab = ws;
			this.#told = null;
			this.#labFeatures = hello.features ?? [];
			this.#token = randomBytes(16).toString("hex");
			this.#say({ type: "hello", protocol: PROTOCOL, token: this.#token, features: FEATURES });
			ws.on("message", (more) => this.#labSaid(JSON.parse(String(more)) as FromLab));
		});
	}

	#labLeft(): void {
		this.#lab = undefined;
		this.#told = null;
		this.#token = "";
		this.#machines = [];
		for (const { socket } of this.#channels.values()) socket.terminate();
		const left = new NotLinked("The lab closed or was reloaded before it answered.");
		for (const running of this.#running.values()) running.fail(left);
		this.#running.clear();
		const closed = new NotLinked(CLOSED_DURING_CALL);
		for (const call of this.#calls.values()) call.fail(closed);
		this.#calls.clear();
		this.#labFeatures = [];
		if (this.#tools.length > 0) {
			this.#tools = [];
			this.#options.on.tools([]);
		}
		if (!this.#linked) return;
		this.#linked = false;
		this.#options.on.linked(false);
		this.#changed();
	}

	#labSaid(message: FromLab): void {
		switch (message.type) {
			case "machines": {
				this.#machines = message.machines;
				const first = !this.#linked;
				this.#linked = true;
				if (first) this.#options.on.linked(true);
				this.#options.on.machines(message.machines);
				this.#changed();
				return;
			}
			case "ask": {
				const { id } = message;
				const no = () => false;
				void this.#running
					.get(id)
					?.ask(message.asking)
					.catch(no)
					.then((yes) => this.#say({ type: "answer", id, yes }));
				return;
			}
			case "result":
				this.#running.get(message.id)?.settle(message.result);
				return;
			case "completion":
				this.#completing.get(message.id)?.(message);
				return;
			case "tools":
				this.#tools = message.tools;
				this.#options.on.tools(message.tools);
				return;
			case "reply":
				this.#calls.get(message.id)?.settle(message.reply);
				return;
		}
	}

	#machineCame(name: string, socket: WebSocket): void {
		// A machine that booted again comes anew, perhaps before its last channel is seen to be gone.
		this.#channels.get(name)?.socket.terminate();
		const mux = new Mux({
			dialled: false,
			send: (message) => socket.send(message),
			asked: (asked) => this.#options.on.asked(name, asked),
		});
		const machine = { mux, socket };
		this.#channels.set(name, machine);
		socket.on("message", (data) => mux.receive(bytesOf(data)));
		socket.on("error", () => socket.terminate());
		socket.on("close", () => {
			mux.close();
			if (this.#channels.get(name) === machine) this.#channels.delete(name);
		});
		this.#changed();
	}
}
