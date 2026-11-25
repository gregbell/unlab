// The CLI as a person runs it, in a directory of its own, and what a person's
// terminal has beside it.

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { WebSocket } from "ws";
import {
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

	/** One command, to its end. */
	once(...args: string[]): Promise<Ran> {
		return this.run(process.execPath, this.#args(args));
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

/** A lab's page, as the CLI sees one: it links, names its machines and gives their workers the token. */
export class TestPage {
	readonly #socket: WebSocket;
	readonly linked: Promise<string>;
	readonly refused: Promise<string>;

	constructor(url: string, options: { origin?: string; protocol?: number } = {}) {
		this.#socket = new WebSocket(url + LAB_PATH, { origin: options.origin ?? LAB_ORIGIN });
		const linked = Promise.withResolvers<string>();
		const refused = Promise.withResolvers<string>();
		this.linked = linked.promise;
		this.refused = refused.promise;
		this.#socket.on("error", (error) => refused.resolve(error.message));
		this.#socket.on("open", () => this.say({ type: "hello", protocol: options.protocol ?? PROTOCOL }));
		this.#socket.on("message", (data) => {
			const message = JSON.parse(String(data)) as FromCli;
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
