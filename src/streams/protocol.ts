// What the lab and the CLI say to each other. The page has one channel of JSON
// messages for commands. Each machine's worker has a channel of its own for
// streams, so that a machine's bytes never wait for the page.

/** Goes up when either end could not understand the other. */
export const PROTOCOL = 1;
/**
 * What each end can do beyond PROTOCOL, said in its hello. Neither sends the
 * other a message of a feature that the other's hello did not list.
 */
export type Feature = "tools";
export const FEATURES: readonly Feature[] = ["tools"];
/**
 * Where the CLI listens, on this computer only, unless it is told otherwise.
 * Below what Linux and macOS hand out to outgoing connections, any of which
 * would hold it against a listener.
 */
export const LINK_PORT = 27122;
/** Where the CLI listened when it opened a lab at `#cli` without saying. */
export const FIRST_LINK_PORT = 47122;
/** The lab's address, whose pages the CLI takes. */
export const LAB_ORIGIN = "https://unlab.run";

export const LAB_PATH = "/lab";
export const MACHINE_PATH = "/machine";

/** Who a machine's channel is for. The token is the one the page was given. */
export function machinePath(token: string, n: number, name: string): string {
	return `${MACHINE_PATH}?${new URLSearchParams({ token, n: String(n), name })}`;
}

// ───────────────────────────── the page's channel ─────────────────────────────

export interface LinkedMachine {
	readonly n: number;
	readonly name: string;
	readonly image: string;
	/** `ready`, `booting`, `off`, `failed`… as the lab's list says it. */
	readonly state: string;
}

/** A command's result, as the command bar gets it. */
export interface RemoteBlock {
	readonly machine: string;
	readonly status: string;
	readonly exitCode: number | null;
	readonly lastLine: string;
	/** What the machine printed, when the command ran one there. */
	readonly output: string | null;
}

export type RemoteResult =
	| {
			readonly ok: true;
			/** One line. */
			readonly text: string;
			readonly blocks: readonly RemoteBlock[];
			readonly rows: readonly { readonly term: string; readonly text: string }[];
			/** What the matching agent tool returns. */
			readonly reply: unknown;
	  }
	| {
			readonly ok: false;
			readonly message: string;
			/** The whole line with one word repaired. */
			readonly fix: string | null;
	  };

export interface Asking {
	readonly question: string;
	readonly detail: string;
	readonly actionLabel: string;
}

/** An agent tool as the lab offers it, which the CLI passes on as it is. */
export interface ToolInfo {
	readonly name: string;
	readonly title: string;
	readonly description: string;
	readonly inputSchema: object;
	readonly annotations: object;
}

export interface RemoteSuggestion {
	readonly insert: string;
	readonly detail: string | null;
}

export type FromLab =
	| { readonly type: "hello"; readonly protocol: number; readonly features?: readonly Feature[] }
	| { readonly type: "machines"; readonly machines: readonly LinkedMachine[] }
	/** What an agent may call now. Said once linked, and again whenever it changes. */
	| { readonly type: "tools"; readonly tools: readonly ToolInfo[] }
	/** A call's answer, `{ error }` for one that failed or was refused. */
	| { readonly type: "reply"; readonly id: number; readonly reply: unknown }
	| { readonly type: "ask"; readonly id: number; readonly asking: Asking }
	| { readonly type: "result"; readonly id: number; readonly result: RemoteResult }
	| {
			readonly type: "completion";
			readonly id: number;
			readonly start: number;
			readonly end: number;
			readonly suggestions: readonly RemoteSuggestion[];
	  };

export type FromCli =
	/** The CLI takes this lab. */
	| {
			readonly type: "hello";
			readonly protocol: number;
			readonly token: string;
			readonly features?: readonly Feature[];
	  }
	/** It does not, and why. One sentence. */
	| { readonly type: "refused"; readonly message: string }
	| { readonly type: "run"; readonly id: number; readonly line: string }
	| { readonly type: "answer"; readonly id: number; readonly yes: boolean }
	/** Ends a `run` or a `call`. */
	| { readonly type: "abort"; readonly id: number }
	/** An agent's call of a tool, which the lab answers as it would one through WebMCP. */
	| { readonly type: "call"; readonly id: number; readonly name: string; readonly input: unknown }
	| { readonly type: "complete"; readonly id: number; readonly line: string; readonly caret: number };

export const CLI_OLDER = "This CLI is older than the lab, so update it with: npx unlab.run@latest";
export const LAB_OLDER = "The lab open in the browser is older than this CLI, so reload the lab.";

/** Why two versions cannot work together, or null when they can. */
export function versionRefusal(cli: number, lab: number): string | null {
	if (cli === lab) return null;
	return cli < lab ? CLI_OLDER : LAB_OLDER;
}

// ───────────────────────────── a machine's channel ─────────────────────────────

/** What the CLI opens in a machine. */
export type ToMachine =
	/** A TCP port on the machine's loopback. */
	| { readonly kind: "port"; readonly port: number }
	/** The SSH server, which is put in the machine first if it is not there. */
	| { readonly kind: "ssh"; readonly keys: SshKeys };

export interface SshKeys {
	/** The server's, in dropbear's format, in base64. */
	readonly hostKey: string;
	/** The line of the one key it takes. */
	readonly authorizedKey: string;
}

/** What a machine opens through the CLI. */
export type FromMachine =
	| { readonly kind: "tcp"; readonly host: string; readonly port: number }
	/** Answered with the IPv4 addresses. */
	| { readonly kind: "lookup"; readonly name: string }
	/** One echo, answered with the far end's TTL, or refused when there is none. */
	| { readonly kind: "ping"; readonly address: string };

export interface Pong {
	readonly ttl: number;
}

/** A lookup's refusal when there is no such name, which is not a failure to ask. */
export const NO_SUCH_NAME = "no such name";
