// The CLI's own commands, which the prompt and a single run share. Every other
// line is the lab's.

import { spawn } from "node:child_process";
import type { Asking, RemoteResult } from "../../src/streams/index.ts";
import { request, type Status } from "./core.ts";
import { lineOf, portPair, USAGE, UsageError } from "./options.ts";
import { exitCode, resultText, statusText } from "./print.ts";

export interface Io {
	out(text: string): void;
	err(text: string): void;
	ask(asking: Asking): Promise<boolean>;
	readonly signal: AbortSignal;
	readonly json: boolean;
	readonly sshConfig: string;
}

/** Their names and one line each, as the lab's `help` lists its own. */
export const OWN: readonly { readonly name: string; readonly about: string }[] = [
	{ name: "ssh", about: "open a shell in a machine" },
	{ name: "forward", about: "make a machine's port one of this computer's" },
	{ name: "status", about: "say what is linked, forwarded and connected" },
	{ name: "exit", about: "leave" },
];

const HELP: Readonly<Record<string, string>> = {
	ssh: "ssh [user@]<machine> [-- command]\nOpens a shell in a machine, or runs a command in it. Without a user it is `user`.\nFrom any other terminal: ssh <machine>.unlab",
	forward:
		"forward <machine> <port>[:<port>]\nMakes a port of a machine one of this computer's: forward web 8080:80 is localhost:8080 here.\nforward alone lists them. forward --rm 8080 ends one.",
	status: "status\nSays what is linked, which ports are forwarded and which connections machines have open.",
	exit: "exit\nLeaves. The machines run on, without the internet that came through here.",
};

/** The person's own ssh, against the CLI's configuration. */
function runSsh(words: readonly string[], io: Io): Promise<number> {
	const [target, ...rest] = words;
	if (!target) throw new UsageError("ssh wants a machine: ssh node1");
	const command = rest[0] === "--" ? rest.slice(1) : rest;
	const host = target.endsWith(".unlab") ? target : `${target}.unlab`;
	const tty = command.length === 0 && process.stdin.isTTY ? ["-t"] : [];
	return new Promise((resolve, reject) => {
		const child = spawn("ssh", ["-F", io.sshConfig, ...tty, host, ...command], { stdio: "inherit" });
		child.once("error", (error: NodeJS.ErrnoException) => {
			reject(error.code === "ENOENT" ? new Error("There is no ssh on this computer. Install OpenSSH.") : error);
		});
		child.once("close", (code) => resolve(code ?? 255));
	});
}

async function forward(words: readonly string[], io: Io): Promise<number> {
	const [machine, ports, ...more] = words;
	if (more.length > 0) throw new UsageError("forward wants a machine and a port: forward web 8080:80");
	if (machine === undefined) {
		const { forwards } = await request<Status>({ type: "status" });
		for (const { machine, local, remote } of forwards) io.out(`localhost:${local} leads to ${machine}:${remote}`);
		if (forwards.length === 0) io.out("Nothing is forwarded.");
		return 0;
	}
	if (ports === undefined) throw new UsageError("forward wants a port too: forward web 8080:80");
	if (machine === "--rm") {
		await request({ type: "unforward", local: portPair(ports).local });
		io.out(`localhost:${portPair(ports).local} is not forwarded any more.`);
		return 0;
	}
	const { local, remote } = portPair(ports);
	await request({ type: "forward", machine, local, remote });
	io.out(`localhost:${local} leads to ${machine}:${remote}`);
	return 0;
}

/** Runs one command. Resolves with what a shell should see, and rejects with a sentence. */
export async function runWords(words: readonly string[], line: string, io: Io): Promise<number> {
	const [verb, ...rest] = words;
	switch (verb) {
		case "ssh":
			return runSsh(rest, io);
		case "forward":
			return forward(rest, io);
		case "status": {
			const status = await request<Status>({ type: "status" });
			io.out(io.json ? JSON.stringify(status) : statusText(status));
			return 0;
		}
		case "help": {
			const own = HELP[rest[0] ?? ""];
			if (own !== undefined) {
				io.out(own);
				return 0;
			}
		}
	}
	const result = await request<RemoteResult>({ type: "run", line }, { ask: io.ask, signal: io.signal });
	if (io.json) {
		io.out(JSON.stringify(result.ok ? result.reply : { error: result.message }));
		return exitCode(result);
	}
	if (!result.ok) io.err(resultText(result));
	else {
		io.out(resultText(result));
		if (verb === "help" && rest.length === 0) {
			io.out("\nAnd the CLI's own:");
			for (const { name, about } of OWN) io.out(`${name.padEnd(10)}  ${about}`);
		}
	}
	return exitCode(result);
}

export { lineOf, USAGE };
