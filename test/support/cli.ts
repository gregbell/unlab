// The CLI as a person runs it, in a directory of its own, and what a person's
// terminal has beside it.

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { WebSocket } from "ws";
import {
	type Feature,
	type FromCli,
	type FromLab,
	LAB_ORIGIN,
	LAB_PATH,
	type LinkedMachine,
	PROTOCOL,
} from "../../src/streams/index.ts";
import type { TestMachine } from "../integration/lab.ts";

const CLI = fileURLToPath(new URL("../../cli/dist/cli.mjs", import.meta.url));

export async function buildCli(): Promise<void> {
	await build({ configFile: fileURLToPath(new URL("../../cli/vite.config.ts", import.meta.url)), logLevel: "error" });
}

export function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
		});
	});
}

export interface Ran {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

export interface CliOptions {
	readonly args?: readonly string[];
	readonly origin?: string;
}

export class TestCli {
	/** Where the CLI keeps its files. */
	readonly dir = mkdtempSync(join(tmpdir(), "unlab-cli-"));
	readonly port: number;
	readonly #options: CliOptions;
	readonly #children = new Set<ChildProcess>();
	readonly #env: NodeJS.ProcessEnv;

	constructor(port: number, options: CliOptions = {}) {
		this.port = port;
		this.#options = options;
		// A person's configuration with the one line in it, and none of the host's own.
		writeFileSync(join(this.dir, "person_config"), `Include ${join(this.dir, "ssh_config")}\n`);
		// A test runner's own settings for colour make Node print warnings among what is tested.
		const { FORCE_COLOR: _, NO_COLOR: __, ...env } = process.env;
		this.#env = { ...env, UNLAB_CONFIG: this.dir };
	}

	get url(): string {
		return `ws://127.0.0.1:${this.port}`;
	}

	#args(args: readonly string[]): string[] {
		const { origin, args: more = [] } = this.#options;
		return [CLI, "--port", String(this.port), ...(origin ? ["--origin", origin] : []), "--no-open", ...more, ...args];
	}

	/** One that stays, at its prompt. */
	start(): Session {
		const child = spawn(process.execPath, this.#args([]), { env: this.#env, stdio: "pipe" });
		this.#children.add(child);
		return new Session(child);
	}

	/** One that stays, at a prompt in a terminal. */
	startInTerminal(): Session {
		const command = [process.execPath, ...this.#args([])].map((word) => `'${word}'`).join(" ");
		// util-linux's script makes the terminal, 120 columns wide.
		const child = spawn("script", ["-qec", `stty cols 120 rows 40; ${command}`, "/dev/null"], {
			env: { ...this.#env, TERM: "xterm-256color" },
			stdio: "pipe",
		});
		this.#children.add(child);
		return new Session(child);
	}

	/** `mcp`, as an agent's client starts it. */
	mcp(): McpSession {
		const child = spawn(process.execPath, this.#args(["mcp"]), { env: this.#env, stdio: "pipe" });
		this.#children.add(child);
		return new McpSession(child);
	}

	/** One command, to its end. */
	once(...args: string[]): Promise<Ran> {
		return this.run(process.execPath, this.#args(args));
	}

	/**
	 * Whether a CLI answers on the socket. Unlike a command, this never starts
	 * one, which would race the CLI that is starting and could hold the port.
	 */
	answers(): Promise<boolean> {
		return new Promise((resolve) => {
			const socket = createConnection(join(this.dir, "cli.sock"));
			let said = "";
			socket.on("data", (data) => {
				said += data;
			});
			socket.once("connect", () => socket.write(`${JSON.stringify({ type: "status" })}\n`));
			socket.once("error", () => resolve(false));
			socket.once("close", () => resolve(said.startsWith('{"type":"ok"')));
		});
	}

	/** Any program, with the person's SSH configuration. */
	run(command: string, args: readonly string[], options: { cwd?: string; input?: string } = {}): Promise<Ran> {
		return new Promise((resolve, reject) => {
			const child = execFile(
				command,
				[...args],
				{ env: this.#env, cwd: options.cwd, maxBuffer: 1 << 28, timeout: 120_000 },
				(error, stdout, stderr) => {
					if (error && typeof error.code !== "number" && !error.killed) reject(error);
					else resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr });
				},
			);
			child.stdin?.end(options.input ?? "");
		});
	}

	ssh(...args: string[]): Promise<Ran> {
		return this.run("ssh", ["-F", join(this.dir, "person_config"), ...args]);
	}

	scp(...args: string[]): Promise<Ran> {
		return this.run("scp", ["-F", join(this.dir, "person_config"), ...args]);
	}

	rsync(...args: string[]): Promise<Ran> {
		return this.run("rsync", ["-e", `ssh -F ${join(this.dir, "person_config")}`, ...args]);
	}

	close(): void {
		for (const child of this.#children) child.kill("SIGKILL");
		rmSync(this.dir, { recursive: true, force: true, maxRetries: 5 });
	}
}

/** A prompt. */
export class Session {
	readonly child: ChildProcess;
	printed = "";
	readonly exited: Promise<number | null>;

	constructor(child: ChildProcess) {
		this.child = child;
		child.stdout?.on("data", (text) => {
			this.printed += text;
		});
		child.stderr?.on("data", (text) => {
			this.printed += text;
		});
		this.exited = new Promise((resolve) => child.once("exit", resolve));
	}

	type(line: string): void {
		this.child.stdin?.write(`${line}\n`);
	}

	/** Keys, as they are. */
	press(keys: string): void {
		this.child.stdin?.write(keys);
	}

	/** Waits for it in what was printed since `from`. */
	async shows(what: string | RegExp, ms = 15_000, from = 0): Promise<void> {
		const until = performance.now() + ms;
		const there = () => {
			const text = this.printed.slice(from);
			return typeof what === "string" ? text.includes(what) : what.test(text);
		};
		while (!there()) {
			if (performance.now() > until) throw new Error(`The CLI did not print ${what}. It printed:\n${this.printed}`);
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}
}

/** An agent's MCP client: a line of JSON each way. */
export class McpSession {
	readonly child: ChildProcess;
	/** Every message on stdout, parsed: a line that is not JSON fails the parse. */
	readonly said: Record<string, unknown>[] = [];
	stderr = "";
	readonly exited: Promise<number | null>;
	#ids = 0;

	constructor(child: ChildProcess) {
		this.child = child;
		let held = "";
		child.stdout?.on("data", (text) => {
			held += text;
			for (let end = held.indexOf("\n"); end >= 0; end = held.indexOf("\n")) {
				this.said.push(JSON.parse(held.slice(0, end)));
				held = held.slice(end + 1);
			}
		});
		child.stderr?.on("data", (text) => {
			this.stderr += text;
		});
		this.exited = new Promise((resolve) => child.once("exit", resolve));
	}

	send(message: object): void {
		this.child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
	}

	/** Sends a request and gives its id. */
	ask(method: string, params?: object): number {
		const id = ++this.#ids;
		this.send({ id, method, params });
		return id;
	}

	async answer(id: number, ms = 15_000): Promise<Record<string, unknown>> {
		await until(
			() => this.said.some((m) => m.id === id),
			ms,
			() => `no answer to ${id}: ${JSON.stringify(this.said)}`,
		);
		return this.said.find((m) => m.id === id) as Record<string, unknown>;
	}

	async request(method: string, params?: object): Promise<Record<string, unknown>> {
		return this.answer(this.ask(method, params));
	}

	/** initialize, then initialized, as a client starts. */
	async begin(): Promise<Record<string, unknown>> {
		const answer = await this.request("initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "test", version: "1" },
		});
		this.send({ method: "notifications/initialized" });
		return answer;
	}

	count(method: string): number {
		return this.said.filter((m) => m.method === method).length;
	}

	async tools(): Promise<string[]> {
		const { result } = await this.request("tools/list");
		return (result as { tools: { name: string }[] }).tools.map((tool) => tool.name);
	}

	/** Ends stdin, as a client that is done does. */
	end(): void {
		this.child.stdin?.end();
	}
}

async function until(ready: () => boolean, ms: number, late: () => string): Promise<void> {
	const end = performance.now() + ms;
	while (!ready()) {
		if (performance.now() > end) throw new Error(late());
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

/** A lab's page, as the CLI sees one: it links, names its machines and gives their workers the token. */
export class TestPage {
	readonly #socket: WebSocket;
	readonly linked: Promise<string>;
	readonly refused: Promise<string>;
	/** Everything the CLI said to it. */
	readonly heard: FromCli[] = [];

	constructor(url: string, options: { origin?: string; protocol?: number; features?: readonly Feature[] } = {}) {
		this.#socket = new WebSocket(url + LAB_PATH, { origin: options.origin ?? LAB_ORIGIN });
		const linked = Promise.withResolvers<string>();
		const refused = Promise.withResolvers<string>();
		this.linked = linked.promise;
		this.refused = refused.promise;
		this.#socket.on("error", (error) => refused.resolve(error.message));
		const { features } = options;
		this.#socket.on("open", () =>
			this.say({ type: "hello", protocol: options.protocol ?? PROTOCOL, ...(features && { features }) }),
		);
		this.#socket.on("message", (data) => {
			const message = JSON.parse(String(data)) as FromCli;
			this.heard.push(message);
			if (message.type === "hello") linked.resolve(message.token);
			if (message.type === "refused") refused.resolve(message.message);
		});
	}

	say(message: FromLab): void {
		this.#socket.send(JSON.stringify(message));
	}

	machines(machines: readonly LinkedMachine[]): void {
		this.say({ type: "machines", machines });
	}

	/** The next message of this type that it hears, from those not yet taken. */
	async hears<T extends FromCli["type"]>(type: T, ms = 15_000): Promise<Extract<FromCli, { type: T }>> {
		const found = (): number => this.heard.findIndex((m) => m.type === type);
		await until(
			() => found() >= 0,
			ms,
			() => `the page did not hear ${type}: ${JSON.stringify(this.heard)}`,
		);
		const [message] = this.heard.splice(found(), 1);
		return message as Extract<FromCli, { type: T }>;
	}

	close(): void {
		this.#socket.terminate();
	}
}

/** Links real machines, as their page would. */
export async function linkMachines(
	cli: TestCli,
	machines: readonly { readonly machine: TestMachine; readonly n: number; readonly image: string }[],
): Promise<TestPage> {
	const page = new TestPage(cli.url);
	const token = await page.linked;
	for (const { machine } of machines) machine.link({ url: cli.url, token, programs: "" });
	page.machines(machines.map(({ machine, n, image }) => ({ n, name: machine.name, image, state: "ready" })));
	return page;
}

export function hasRsync(): boolean {
	return (process.env.PATH ?? "").split(":").some((dir) => existsSync(join(dir, "rsync")));
}
