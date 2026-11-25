// The prompt: a line at a time, to the lab or to the CLI's own commands.

import { readFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface, type Interface } from "node:readline";
import type { Asking } from "../../src/streams/index.ts";
import { type Notice, NotRunning, request, type Status, watch } from "./core.ts";
import { configDir } from "./keys.ts";
import { askingText, machinesLine } from "./print.ts";
import type { Completion } from "./server.ts";
import { OWN, runWords } from "./words.ts";

const HISTORY = 500;

const historyPath = () => join(configDir(), "history");

/** Newest first, as readline keeps it. */
function readHistory(): string[] {
	try {
		const lines = readFileSync(historyPath(), "utf8").split("\n").filter(Boolean);
		return lines.slice(-HISTORY).reverse();
	} catch {
		return [];
	}
}

/** The lab's suggestions for the caret, as readline wants them, with the CLI's own words. */
export async function complete(
	line: string,
	labs: (line: string, caret: number) => Promise<Completion>,
	machines: () => Promise<readonly string[]>,
): Promise<[string[], string]> {
	const own = /^(ssh|forward)\s+(?:(\w+)@)?([^\s@]*)$/.exec(line);
	if (own) {
		const [, , user, typed] = own;
		const at = user ? `${user}@` : "";
		const names = (await machines()).filter((name) => name.startsWith(typed));
		return [names.map((name) => `${at}${name} `), `${at}${typed}`];
	}
	const { start, suggestions } = await labs(line, line.length);
	const typed = line.slice(start);
	const inserts = suggestions.map(({ insert }) => `${insert} `);
	if (!/\s/.test(line)) inserts.push(...OWN.map(({ name }) => `${name} `).filter((name) => name.startsWith(line)));
	return [inserts.filter((insert) => insert.startsWith(typed)), typed];
}

export function noticeText(notice: Notice): string {
	switch (notice.kind) {
		case "linked":
			return machinesLine(notice.machines);
		case "unlinked":
			return "The lab is not linked any more. Waiting for it.";
		case "refused":
			return notice.message;
		case "ready":
			return notice.machines.map((name) => `${name} is ready.`).join("\n");
		case "connection":
			return notice.text;
	}
}

export interface PromptOptions {
	readonly sshConfig: string;
	readonly input: NodeJS.ReadStream;
	readonly output: NodeJS.WriteStream;
	readonly errors: NodeJS.WriteStream;
}

/** Until the person leaves, or the CLI it talks to quits. */
export async function prompt({ sshConfig, input, output, errors }: PromptOptions): Promise<void> {
	const out = (text: string) => output.write(`${text}\n`);
	const ended = Promise.withResolvers<void>();
	let reader: Interface | undefined;
	let running: AbortController | undefined;
	/** Answers the question that is on the screen. */
	let answering: ((text: string) => void) | undefined;
	const history = readHistory();

	const show = (text: string) => {
		if (!reader || running || !output.isTTY) {
			out(text);
			return;
		}
		// Above the line that is being typed, which stays as it is.
		output.write("\r\x1b[K");
		out(text);
		reader.prompt(true);
	};

	const ask = (asking: Asking) =>
		new Promise<boolean>((resolve) => {
			out(askingText(asking));
			answering = (text) => {
				answering = undefined;
				resolve(/^y(es)?$/i.test(text.trim()));
			};
			reader?.setPrompt(`${asking.actionLabel}? [y/N] `);
			reader?.prompt();
		});

	const line = async (text: string) => {
		const words = text.trim().split(/\s+/).filter(Boolean);
		if (words.length === 0) return;
		if (words[0] === "exit" || words[0] === "quit") {
			ended.resolve();
			return;
		}
		await appendFile(historyPath(), `${text.trim()}\n`, { mode: 0o600 }).catch(() => {});
		const abort = new AbortController();
		running = abort;
		const takesTerminal = words[0] === "ssh";
		if (takesTerminal) close();
		try {
			await runWords(words, text.trim(), {
				out,
				err: (said) => errors.write(`${said}\n`),
				ask,
				signal: abort.signal,
				json: false,
				sshConfig,
			});
		} catch (error) {
			if (error instanceof NotRunning) {
				out(error.message);
				ended.resolve();
				return;
			}
			if (!abort.signal.aborted) errors.write(`${error instanceof Error ? error.message : String(error)}\n`);
		} finally {
			running = undefined;
			answering = undefined;
			if (takesTerminal) open();
		}
	};

	const next = () => {
		reader?.setPrompt("unlab> ");
		reader?.prompt();
	};

	let queue = Promise.resolve();
	const close = () => {
		const closing = reader;
		reader = undefined;
		closing?.close();
	};
	const open = () => {
		const opened = createInterface({
			input,
			output,
			terminal: input.isTTY,
			history: [...history],
			historySize: HISTORY,
			completer: (text: string, done: (error: Error | null, result: [string[], string]) => void) => {
				complete(
					text,
					(line, caret) => request<Completion>({ type: "complete", line, caret }),
					async () => (await request<Status>({ type: "status" })).machines.map((m) => m.name),
				).then(
					(result) => done(null, result),
					() => done(null, [[], text]),
				);
			},
		});
		reader = opened;
		opened.on("history", (now) => history.splice(0, history.length, ...now));
		opened.on("SIGINT", () => {
			if (answering) answering("");
			else if (running) {
				running.abort(new Error("Cancelled."));
				out("^C");
			} else {
				opened.write(null, { ctrl: true, name: "e" });
				opened.write(null, { ctrl: true, name: "u" });
				output.write("^C\n");
				next();
			}
		});
		opened.on("close", () => {
			if (reader !== opened) return;
			// In a terminal it is Ctrl-D. Without one it is the end of what was piped in, or a job in the background.
			if (input.isTTY) queue = queue.then(() => ended.resolve());
			else {
				reader = undefined;
				queue = queue.then(() => {
					out("Input ended. The CLI runs on until it is stopped.");
				});
			}
		});
		opened.on("line", (text) => {
			if (answering) {
				answering(text);
				return;
			}
			queue = queue.then(() => line(text)).then(next);
		});
	};

	const unwatch = await watch(
		(notice) => show(noticeText(notice)),
		() => {
			show("The CLI that was running has quit.");
			ended.resolve();
		},
	);
	const status = await request<Status>({ type: "status" });
	if (status.linked) out(machinesLine(status.machines));
	open();
	next();
	await ended.promise;
	unwatch();
	close();
}
