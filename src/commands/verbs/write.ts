import type { MachineName } from "../../model/index.ts";
import { defineVerb, refuse } from "../define.ts";
import * as slots from "../grammar/slots.ts";
import { lineError } from "../types.ts";
import { count } from "./words.ts";

export interface WriteData {
	readonly machine: MachineName;
	/** The file that was written, once links were followed. */
	readonly path: string;
	readonly bytes: number;
	readonly owner: string;
	readonly mode: string;
}

/** A guest takes one of this size in well under a second. */
export const MAX_TEXT_BYTES = 2 ** 20;

const bytesOf = (text: string): number => new TextEncoder().encode(text).length;

/** `3 lines, 120 bytes` */
function size(text: string): string {
	if (text === "") return "empty";
	const lines = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
	return `${count(lines, "line")}, ${count(bytesOf(text), "byte")}`;
}

/** Why the text cannot be a file's, or null. */
function textFault(text: string): string | null {
	const bytes = bytesOf(text);
	if (bytes > MAX_TEXT_BYTES) return `text has ${bytes} bytes, and write takes at most ${MAX_TEXT_BYTES}.`;
	if (text.isWellFormed()) return null;
	return "text has half of a surrogate pair in it, which is no character and cannot be written as UTF-8.";
}

export const write = defineVerb({
	name: "write",
	about: "put a text in a file on a machine",
	danger: false,
	grammar: {
		machine: slots.machine(),
		path: slots.filePath(),
		owner: slots.option("--owner", slots.owner(), null),
		mode: slots.option("--mode", slots.fileMode(), null),
		text: slots.verbatim("text"),
	},
	plan({ machine, path, owner, mode, text }, lab) {
		if (lab.machines[machine]?.life.phase !== "ready") return refuse(`${machine} is no longer ready.`, "machine");
		const fault = textFault(text);
		if (fault !== null) return refuse(fault, "text");
		return { machine, file: { path, owner, mode, text } };
	},
	describe({ machine, file: { path, owner, mode, text } }) {
		return [
			`write ${path} on ${machine}`,
			size(text),
			...(owner === null ? [] : [`owner ${owner}`]),
			...(mode === null ? [] : [`mode ${mode}`]),
		].join(" · ");
	},
	async execute({ machine, file }, ctx, deps) {
		const outcome = await deps.files.write(machine, file, ctx.signal);
		switch (outcome.kind) {
			case "refused":
				return { kind: "failed", error: lineError(outcome.reason) };
			case "unsure":
				return { kind: "failed", error: { message: outcome.reason } };
			case "written": {
				const { path, owner, mode } = outcome;
				const data: WriteData = { machine, path, bytes: bytesOf(file.text), owner, mode };
				return {
					kind: "report",
					header: `wrote ${path} on ${machine} · ${size(file.text)} · ${owner} ${mode}`,
					blocks: [],
					data,
				};
			}
		}
	},
	tool: {
		name: "file_write",
		title: "Write a file",
		description:
			"Put a text in a file on a machine, as root, in place of what is there. No terminal sees it. The text arrives byte for byte, so end it with a newline if the file should. A link is followed. The file is replaced whole or left as it was, and is on the machine's disk when this returns. Returns the file's path, size, owner and mode.",
		policy: "run",
		annotations: { untrustedContentHint: true },
	},
});
