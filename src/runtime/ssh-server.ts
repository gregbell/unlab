// The SSH server that the CLI's connections reach. It is put in the machine's
// memory the first time one is asked for, and nothing of it is on a disk: the
// programs, the host key and the authorised key are in /run, a tmpfs. It
// listens on the machine's loopback alone, where no other machine can reach it.

import type { ExecOptions, ExecResult, KernelHandle } from "unkernel";
import type { SshKeys } from "../streams/index.ts";
import { sh } from "./guest.ts";

export interface SshProgram {
	readonly name: string;
	readonly bytes: Uint8Array;
}

/** Where they look for each other, which they were built with. */
export interface SshPrograms {
	readonly dir: string;
	readonly programs: readonly SshProgram[];
}

/** Not 22, which is a scenario's to use. The first that is free. */
const PORTS = { first: 47022, tried: 20 } as const;

type Guest = Pick<KernelHandle, "exec">;

/** dropbear opens its port before it goes to the background, so a port that is taken is its exit status. */
function startScript(dir: string): string {
	return [
		`cd ${sh(dir)} || exit 1`,
		"umask 077",
		`if [ -f pid ]; then kill "$(cat pid)" 2>/dev/null; rm -f pid; fi`,
		`printf '%s' "$1" | base64 -d > host_key`,
		`printf '%s\\n' "$2" > authorized_keys`,
		"chmod 644 authorized_keys",
		`port=${PORTS.first}`,
		`while [ "$port" -lt ${PORTS.first + PORTS.tried} ]; do`,
		`  if ./dropbear -s -r ${sh(`${dir}/host_key`)} -D ${sh(dir)} -P ${sh(`${dir}/pid`)} -p "127.0.0.1:$port" </dev/null >/dev/null 2>&1; then`,
		`    echo "$port"; exit 0`,
		"  fi",
		"  port=$((port + 1))",
		"done",
		`echo "no port from ${PORTS.first} is free" >&2; exit 1`,
	].join("\n");
}

/** The server in one guest. A connection asks for its port, and starts it when it is not there. */
export class SshServer {
	readonly #guest: Guest;
	readonly #programs: () => Promise<SshPrograms>;
	#installed: Promise<string> | undefined;
	#running: { readonly keys: string; readonly port: Promise<number> } | undefined;

	constructor(guest: Guest, programs: () => Promise<SshPrograms>) {
		this.#guest = guest;
		this.#programs = programs;
	}

	/** The port it listens on, with those keys. Rejects with a sentence. */
	port(keys: SshKeys): Promise<number> {
		const named = JSON.stringify(keys);
		if (this.#running?.keys === named) return this.#running.port;
		const before = this.#running?.port ?? Promise.resolve();
		const port = before.then(
			() => this.#start(keys),
			() => this.#start(keys),
		);
		const running = { keys: named, port };
		this.#running = running;
		port.catch(() => {
			if (this.#running === running) this.#running = undefined;
		});
		return port;
	}

	/** Nothing listens on the port it had: someone ended it. */
	lost(): void {
		this.#running = undefined;
	}

	async #start(keys: SshKeys): Promise<number> {
		this.#installed ??= this.#install();
		let dir: string;
		try {
			dir = await this.#installed;
		} catch (error) {
			this.#installed = undefined;
			throw error;
		}
		const started = await this.#root(startScript(dir), [keys.hostKey, keys.authorizedKey]);
		return Number(started.trim());
	}

	async #install(): Promise<string> {
		const { dir, programs } = await this.#programs();
		for (const { name, bytes } of programs) {
			const path = sh(`${dir}/${name}`);
			await this.#root(`mkdir -p ${sh(dir)} && chmod 755 ${sh(dir)} && cat > ${path} && chmod 755 ${path}`, [], {
				input: bytes,
			});
		}
		return dir;
	}

	async #root(script: string, args: string[], options: ExecOptions = {}): Promise<string> {
		const ran: ExecResult = await this.#guest.exec("/bin/sh", ["-c", script, "sh", ...args], {
			...options,
			encoding: "utf8",
			user: "root",
		});
		if (ran.exitCode !== 0) throw new Error(`The SSH server did not start: ${ran.stderr.trim() || "no reason given"}.`);
		return ran.stdout;
	}
}

interface Manifest {
	readonly guestDir: string;
	readonly programs: readonly { readonly name: string; readonly file: string; readonly sha256: string }[];
}

async function bytesOf(url: string): Promise<Uint8Array<ArrayBuffer>> {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`The SSH server could not be fetched: HTTP ${response.status}.`);
	return new Uint8Array(await response.arrayBuffer());
}

/** Fetches them from beside the lab and checks them against the manifest that was built with them. */
export async function fetchSshPrograms(base: string): Promise<SshPrograms> {
	const manifest = JSON.parse(new TextDecoder().decode(await bytesOf(new URL("manifest.json", base).href))) as Manifest;
	const programs = await Promise.all(
		manifest.programs.map(async ({ name, file, sha256 }) => {
			const bytes = await bytesOf(new URL(file, base).href);
			const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
			const hex = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
			if (hex !== sha256) throw new Error(`${name} is not the one the lab was built with, so it was not used.`);
			return { name, bytes };
		}),
	);
	return { dir: manifest.guestDir, programs };
}
