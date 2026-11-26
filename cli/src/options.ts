// What was typed after `npx unlab.run`: the CLI's own options, and then a
// command and its words, which are left as they are for the lab to read.

import { LAB_ORIGIN, LINK_PORT } from "../../src/streams/index.ts";

export interface Options {
	readonly port: number;
	readonly origin: string;
	readonly lan: boolean;
	readonly log: boolean;
	readonly open: boolean;
	/** Seconds for the lab to link, the browser's question among them. */
	readonly wait: number;
	readonly json: boolean;
	readonly yes: boolean;
	readonly help: boolean;
	readonly version: boolean;
	/** Empty for the prompt. */
	readonly words: readonly string[];
}

export class UsageError extends Error {
	override readonly name = "UsageError";
}

export const USAGE = `Usage: npx unlab.run [options] [command]

Without a command, links to the lab in your browser and gives a prompt.
With one, runs it and exits: npx unlab.run exec node1 -- uname -a

Commands of its own:
  ssh <machine> [command]        open a shell in a machine, or run a command in it
  forward <machine> <port>[:<port>]  make a machine's port one of this computer's
  forward                        list them; forward --rm <port> ends one
  status                         say what is linked, forwarded and connected
  ssh-config                     print the line that lets any terminal use ssh <machine>.unlab
  mcp                            give an AI agent the lab's tools, as an MCP server on stdio
Any other command is the lab's: help lists them.

Options:
  --json         print a command's data
  --yes          say yes to a command that asks first
  --log          print each connection that a machine opens
  --lan          let machines reach this computer and its local network
  --no-open      do not open the browser
  --wait <s>     how long a single command waits for the lab: 60 seconds unless said
  --origin <url> a lab elsewhere than ${LAB_ORIGIN}
  --port <n>     listen elsewhere than ${LINK_PORT}
  --version, --help
`;

const FLAGS = ["--json", "--yes", "--log", "--lan", "--no-open", "--version", "--help"] as const;

export function readOptions(args: readonly string[]): Options {
	const flags = new Set<string>();
	let port = LINK_PORT;
	let origin: string = LAB_ORIGIN;
	let wait = 60;
	let at = 0;
	for (; at < args.length; at++) {
		const arg = args[at];
		if (!arg.startsWith("-")) break;
		const [name, inline] = arg.split(/=(.*)/s);
		if (name === "--port" || name === "--origin" || name === "--wait") {
			const value = inline ?? args[++at];
			if (value === undefined) throw new UsageError(`${name} needs a value.`);
			if (name === "--port") {
				port = Number(value);
				if (!Number.isInteger(port) || port < 1 || port > 65535) {
					throw new UsageError(`--port wants a number from 1 to 65535, not ${value}.`);
				}
			} else if (name === "--wait") {
				wait = Number(value);
				if (!(wait >= 0 && wait <= 86_400)) throw new UsageError(`--wait wants a number of seconds, not ${value}.`);
			} else {
				if (!URL.canParse(value))
					throw new UsageError(`--origin wants an address such as ${LAB_ORIGIN}, not ${value}.`);
				origin = new URL(value).origin;
			}
		} else if ((FLAGS as readonly string[]).includes(arg)) flags.add(arg);
		else throw new UsageError(`There is no option ${arg}. See --help.`);
	}
	return {
		port,
		origin,
		lan: flags.has("--lan"),
		log: flags.has("--log"),
		open: !flags.has("--no-open"),
		wait,
		json: flags.has("--json"),
		yes: flags.has("--yes"),
		help: flags.has("--help"),
		version: flags.has("--version"),
		words: args.slice(at),
	};
}

/** A word as the lab's command line reads it back. */
function quoted(word: string): string {
	return word.replace(/([\\ ])/g, "\\$1");
}

/**
 * The words of a shell's command as a line for the lab. What follows `--` is
 * the machine's own command, which the lab takes as it is: one word there is a
 * script, and several are quoted for the machine's shell as they came.
 */
export function lineOf(words: readonly string[]): string {
	const split = words.indexOf("--");
	if (split < 0) return words.map(quoted).join(" ");
	const own = words.slice(0, split).map(quoted);
	const rest = words.slice(split + 1);
	const command = rest.length === 1 ? rest[0] : rest.map(shellWord).join(" ");
	return [...own, "--", command].join(" ");
}

export function shellWord(word: string): string {
	return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

export interface PortPair {
	readonly local: number;
	readonly remote: number;
}

/** `8080:80`, or `80` for the same port at both ends. */
export function portPair(text: string): PortPair {
	const [local, remote = local, ...more] = text.split(":").map(Number);
	const good = (n: number) => Number.isInteger(n) && n >= 1 && n <= 65535;
	if (more.length > 0 || !good(local) || !good(remote)) {
		throw new UsageError(`A port is a number from 1 to 65535, or two as in 8080:80, not ${text}.`);
	}
	return { local, remote };
}
