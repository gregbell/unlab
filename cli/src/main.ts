#!/usr/bin/env node
// `npx unlab.run`: links the lab in the browser with this computer.

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface as createLineReader } from "node:readline";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import type { Asking, ToolInfo } from "../../src/streams/index.ts";
import { Core, NotRunning, proxy, request, type Status, watch } from "./core.ts";
import { configDir, keep } from "./keys.ts";
import { McpServer } from "./mcp.ts";
import { lineOf, type Options, readOptions, USAGE, UsageError } from "./options.ts";
import { askingText } from "./print.ts";
import { prompt } from "./prompt.ts";
import { runWords } from "./words.ts";

declare const UNLAB_VERSION: string;

/** A lab that is open tries about once a second, so one that has not come by now is not open, or has never linked. */
const OPEN_MS = 2500;

/**
 * Where `ssh` finds this program later: npx may empty its cache while a
 * terminal still uses the configuration that names it.
 */
function keepProgram(): readonly string[] {
	const dir = configDir();
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const kept = join(dir, "cli.mjs");
	const self = fileURLToPath(import.meta.url);
	if (self !== kept) keep(kept, readFileSync(self), 0o644);
	return [process.execPath, kept];
}

function openBrowser(url: string): void {
	const [command, args] =
		process.platform === "darwin"
			? ["open", [url]]
			: process.env.BROWSER
				? [process.env.BROWSER, [url]]
				: ["xdg-open", [url]];
	const child = spawn(command, args as string[], { stdio: "ignore", detached: true });
	child.once("error", () => process.stderr.write(`Open ${url} in your browser.\n`));
	child.unref();
}

const labUrl = ({ origin, port }: Options) => `${origin}/#cli=${port}`;

/** How long another run of the CLI may hold the port before it answers, as it starts or as it ends. */
const STARTING_MS = 3000;

/** The CLI that runs, or this one once it does. Null for one that was running. */
async function start(options: Options): Promise<Core | null> {
	const command = keepProgram();
	for (const until = Date.now() + STARTING_MS; ; ) {
		try {
			await request<Status>({ type: "status" });
			return null;
		} catch (error) {
			if (!(error instanceof NotRunning)) throw error;
		}
		const core = new Core({
			port: options.port,
			origins: [options.origin],
			lan: options.lan,
			log: options.log,
			command,
		});
		try {
			await core.start();
			return core;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
		}
		if (Date.now() > until) {
			throw new Error(`Another program has port ${options.port}. Quit it, or choose another with --port.`);
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

/** Rejects when the lab that came cannot be used: waiting on, or opening it again, would not change that. */
async function linked(ms: number): Promise<void> {
	const refused = await request<string | null>({ type: "wait", ms });
	if (refused !== null) throw new Unusable(refused);
}

class Unusable extends Error {
	override readonly name = "Unusable";
}

async function waitForLab(options: Options): Promise<void> {
	try {
		await linked(Math.min(OPEN_MS, options.wait * 1000));
		return;
	} catch (error) {
		if (error instanceof NotRunning || error instanceof Unusable) throw error;
	}
	const url = labUrl(options);
	if (options.open) {
		process.stderr.write(`Opening ${url}\nIf the browser asks, allow the lab to reach apps on this device.\n`);
		openBrowser(url);
	} else process.stderr.write(`Open ${url} in your browser.\n`);
	await linked(options.wait * 1000);
}

async function once(options: Options, core: Core | null): Promise<number> {
	const abort = new AbortController();
	process.once("SIGINT", () => abort.abort(new Error("Cancelled.")));
	if (options.words[0] !== "status") await waitForLab(options);
	const unwatch = options.log
		? await watch(
				(notice) => notice.kind === "connection" && process.stderr.write(`${notice.text}\n`),
				() => {},
			)
		: () => {};
	const ask = async (asking: Asking) => {
		if (options.yes) return true;
		if (!process.stdin.isTTY) {
			process.stderr.write(`${askingText(asking)}\nAdd --yes before the command to say yes.\n`);
			return false;
		}
		const reader = createInterface({ input: process.stdin, output: process.stderr });
		const said = await reader.question(`${askingText(asking)}\n${asking.actionLabel}? [y/N] `);
		reader.close();
		return /^y(es)?$/i.test(said.trim());
	};
	try {
		return await runWords(options.words, lineOf(options.words), {
			out: (text) => process.stdout.write(`${text}\n`),
			err: (text) => process.stderr.write(`${text}\n`),
			ask,
			signal: abort.signal,
			json: options.json,
			sshConfig: core?.sshConfig ?? join(configDir(), "ssh_config"),
		});
	} finally {
		unwatch();
	}
}

async function interactive(options: Options, core: Core | null): Promise<void> {
	if (!core) process.stdout.write("The CLI is already running, so this uses it.\n");
	else {
		if (options.lan) process.stdout.write("Machines may reach this computer and its local network.\n");
		process.stdout.write("Waiting for the lab.\n");
	}
	// One that joins a CLI with no lab, such as an agent's, opens the lab all the same.
	void waitForLab(options).catch(() => {});
	await prompt({
		sshConfig: core?.sshConfig ?? join(configDir(), "ssh_config"),
		input: process.stdin,
		output: process.stdout,
		errors: process.stderr,
	});
}

/** How long it waits before it tries again to join or start the CLI. */
const REJOIN_MS = 1000;

/**
 * Serves MCP on stdio until the client closes it. It joins the CLI that runs,
 * or starts one, and does so again when that one quits. It never opens the
 * browser. Its stdout carries only MCP.
 */
async function serveMcp(options: Options): Promise<number> {
	let tools: readonly ToolInfo[] = [];
	let core = null as Core | null;
	let trouble: string | null = null;
	let unwatch = () => {};
	let closed = false;
	const server = new McpServer({
		version: UNLAB_VERSION,
		send: (message) => process.stdout.write(`${JSON.stringify(message)}\n`),
		tools: () => tools,
		call: (name, input, signal) =>
			trouble === null ? request({ type: "call", name, input }, { signal }) : Promise.reject(new Error(trouble)),
	});
	const offer = (next: readonly ToolInfo[]) => {
		if (JSON.stringify(next) === JSON.stringify(tools)) return;
		tools = next;
		server.changed();
	};
	const join = async (): Promise<void> => {
		while (!closed) {
			try {
				core ??= await start(options);
				unwatch = await watch(
					(notice) => notice.kind === "tools" && offer(notice.tools),
					() => {
						offer([]);
						void join();
					},
				);
				offer((await request<Status>({ type: "status" })).tools);
				trouble = null;
				return;
			} catch (error) {
				const said = error instanceof Error ? error.message : String(error);
				if (said !== trouble) process.stderr.write(`${said}\n`);
				trouble = said;
				await new Promise((resolve) => setTimeout(resolve, REJOIN_MS));
			}
		}
	};
	const stop = () => {
		closed = true;
		unwatch();
		server.close();
	};
	for (const signal of ["SIGTERM", "SIGHUP"] as const) {
		process.once(signal, () => {
			stop();
			core?.stop();
			process.exit(128 + (signal === "SIGTERM" ? 15 : 1));
		});
	}
	const input = createLineReader({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
	input.on("line", (line) => server.receive(line));
	const ended = new Promise((resolve) => input.once("close", resolve));
	void join();
	await ended;
	stop();
	// Another that uses this CLI keeps it until it is done.
	await core?.idle();
	core?.stop();
	return 0;
}

async function main(args: readonly string[]): Promise<number> {
	if (args[0] === "proxy" && args[1] !== undefined) {
		await proxy(args[1], args[2]);
		return 0;
	}
	const options = readOptions(args);
	if (options.help) {
		process.stdout.write(USAGE);
		return 0;
	}
	if (options.version) {
		process.stdout.write(`${UNLAB_VERSION}\n`);
		return 0;
	}
	if (options.words[0] === "mcp") return serveMcp(options);
	if (options.words[0] === "ssh-config") {
		process.stdout.write(`Include ${join(configDir(), "ssh_config")}\n`);
		return 0;
	}
	const core = await start(options);
	const stop = () => core?.stop();
	const signals = ["SIGTERM", "SIGHUP"] as const;
	for (const signal of signals) {
		process.once(signal, () => {
			stop();
			process.exit(128 + (signal === "SIGTERM" ? 15 : 1));
		});
	}
	try {
		if (options.words.length > 0) {
			const code = await once(options, core);
			await core?.idle();
			return code;
		}
		await interactive(options, core);
		return 0;
	} finally {
		stop();
	}
}

main(process.argv.slice(2)).then(
	(code) => process.exit(code),
	(error: unknown) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(error instanceof UsageError ? 2 : 1);
	},
);
