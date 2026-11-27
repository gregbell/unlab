// The tool table: one tool per verb that has a tool face, plus two reads the
// bar has no verb for. A verb tool turns its input into a bar line and parses
// it like anything typed, so the agent meets the same validator, preview, log
// and error sentences as a person.

import { type CaptureView, captureRow, type FrameEntry } from "../capture/index.ts";
import { grantApproval } from "../commands/approval.ts";
import {
	isLineError,
	type JsonSchema,
	type LineError,
	noField,
	type ParsedLine,
	parseLine,
	type Registry,
	type Result,
	slotSchema,
	slots,
	type ToolAnnotations,
	type ToolFace,
	written,
} from "../commands/index.ts";
import {
	DEFAULT_POLICIES,
	type LabState,
	type MachineName,
	machineList,
	parseSessionId,
	type SessionId,
	selectNames,
	severalNics,
	switchLabel,
	type ToolName,
} from "../model/index.ts";
import { compileFilter } from "../net/index.ts";

/** What a finished call gives back: a short line for the panel and the value the agent reads. */
export interface Answer {
	readonly summary: string;
	readonly reply: unknown;
}

/**
 * A tool call checked against the lab, before any policy decides it.
 * `run` is only called once the policy or the person has said yes.
 */
export type Prepared =
	| { readonly ok: false; readonly line: string; readonly error: string }
	| {
			readonly ok: true;
			/** The call as the panel and the log write it: `rm node3`. */
			readonly line: string;
			/** What an approval block says will happen. */
			readonly preview: string;
			/** The approval button, named for the action: `Remove node3`. */
			readonly actionLabel: string;
			/** Rejects with an Error whose message is a sentence for the agent. */
			run(signal: AbortSignal): Promise<Answer>;
	  };

export interface AgentTool {
	readonly name: ToolName;
	readonly title: string;
	readonly description: string;
	readonly inputSchema: JsonSchema;
	readonly annotations: ToolAnnotations;
	prepare(input: unknown, lab: LabState): Prepared;
}

/** The text a session's terminal still shows. The runtime's screens satisfy it. */
export interface SessionScreens {
	get(session: SessionId): { lastLines(n: number): string } | undefined;
}

export interface ReadDeps {
	readonly screens: SessionScreens;
	readonly capture: Pick<CaptureView, "frames">;
}

/** The order of the handoff's tools table, which the panel lists them in. */
const ORDER = Object.keys(DEFAULT_POLICIES);

export function toolTable(registry: Registry, reads: ReadDeps): readonly AgentTool[] {
	const verbs = registry.commands.flatMap(({ tool }) => (tool ? [verbTool(registry, tool)] : []));
	return [...verbs, shellRead(reads.screens), captureRead(reads.capture)].sort(
		(a, b) => ORDER.indexOf(a.name) - ORDER.indexOf(b.name),
	);
}

function capitalised(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The call as the agent made it, for a call whose input never became a line. */
function asCalled(name: ToolName, input: unknown): string {
	return `${name}(${written(input)})`;
}

/** One line for the panel: `exit 0 · hello`, `removed node3`, `2 machines · 2 ready`. */
function summarise(result: Exclude<Result, { kind: "failed" }>): string {
	if (result.kind === "visible") return result.text;
	const [only, ...more] = result.blocks;
	if (only && more.length === 0 && only.status.kind === "exit") {
		return only.lastLine === "" ? `exit ${only.status.code}` : `exit ${only.status.code} · ${only.lastLine}`;
	}
	return result.header;
}

/** The most of a text that an approval shows. */
const EXCERPT_MAX = 10_000;

/** The start of a text, as it is, and how much more there is. */
function excerpt(text: string): string {
	if (text.length <= EXCERPT_MAX) return text;
	return `${text.slice(0, EXCERPT_MAX)}…\n(${text.length - EXCERPT_MAX} more characters are not shown)`;
}

interface Asked {
	readonly preview: string;
	readonly actionLabel: string;
	/** Runs the line as it was asked. Only called once the standing policy or the person said yes to it. */
	run(signal: AbortSignal): Promise<Result>;
}

/** A danger line asks with its own confirmation; any other line with its preview and the preview's first clause. */
function ask(line: ParsedLine, lab: LabState): Asked | LineError {
	if (line.danger) {
		const asked = line.confirm(lab);
		if (isLineError(asked)) return asked;
		return {
			preview: asked.detail,
			actionLabel: asked.actionLabel,
			run: (signal) => line.run({ source: "agent", signal, approval: grantApproval(line.line, asked) }),
		};
	}
	const preview = line.preview(lab);
	if (isLineError(preview)) return preview;
	const [action = line.verb] = preview.will.split(" · ");
	return {
		preview: [`Will ${preview.will}.`, ...(line.shown.text === null ? [] : [excerpt(line.shown.text)])].join("\n"),
		actionLabel: capitalised(action),
		run: (signal) => line.run({ source: "agent", signal }),
	};
}

function verbTool(registry: Registry, tool: ToolFace): AgentTool {
	return {
		name: tool.name,
		title: tool.title,
		description: tool.description,
		inputSchema: tool.inputSchema,
		annotations: tool.annotations,
		prepare(input, lab) {
			const text = tool.toLine(input);
			if (typeof text !== "string") return { ok: false, line: asCalled(tool.name, input), error: text.message };
			const line = parseLine(registry, text, lab);
			if (isLineError(line)) return { ok: false, line: tool.shown(text).line, error: line.message };
			const called = line.shown.line;
			const invalid = line.validate(lab);
			if (invalid) return { ok: false, line: called, error: invalid.message };
			const asked = ask(line, lab);
			if (isLineError(asked)) return { ok: false, line: called, error: asked.message };
			return {
				ok: true,
				line: called,
				preview: asked.preview,
				actionLabel: asked.actionLabel,
				async run(signal) {
					const result = await asked.run(signal);
					if (result.kind === "failed") throw new Error(result.error.message);
					const summary = summarise(result);
					const said = result.kind === "report" ? result.header : summary;
					return { summary, reply: { result: said, data: result.data } };
				},
			};
		},
	};
}

type Fields =
	| { readonly ok: true; readonly fields: ReadonlyMap<string, unknown> }
	| { readonly ok: false; readonly error: string };

/** The input as named fields, refusing any the tool does not have. */
function fieldsOf(name: ToolName, input: unknown, known: readonly string[]): Fields {
	if (input === undefined || input === null) return { ok: true, fields: new Map() };
	if (typeof input !== "object" || Array.isArray(input)) {
		return { ok: false, error: `${name} wants its input as an object of fields, not ${written(input)}.` };
	}
	const fields = new Map(Object.entries(input));
	const unknown = [...fields.keys()].find((key) => !known.includes(key));
	if (unknown !== undefined) return { ok: false, error: noField(name, unknown, known) };
	return { ok: true, fields };
}

function wholeNumber(
	name: ToolName,
	key: string,
	value: unknown,
	fallback: number,
	max: number,
): number | { readonly error: string } {
	if (value === undefined) return fallback;
	if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= max) return value;
	return { error: `${name} wants ${key} as a whole number from 1 to ${max}, not ${written(value)}.` };
}

/** A session as given, or a machine's active session. */
function sessionOf(target: MachineName | SessionId, lab: LabState): SessionId | undefined {
	const address = parseSessionId(target);
	if (address) return address.session;
	return machineList(lab).find((machine) => machine.name === target)?.activeSession;
}

const SHELL_LINES = 20;
const SHELL_MAX = 500;

function shellRead(screens: SessionScreens): AgentTool {
	const name = "shell_read";
	const target = slots.target();
	return {
		name,
		title: "Read a terminal",
		description:
			"Read the last lines a machine's session shows, as its terminal draws them. The text comes from the guest.",
		inputSchema: {
			type: "object",
			properties: {
				machine: slotSchema(target),
				lines: { type: "integer", minimum: 1, default: SHELL_LINES, description: `At most ${SHELL_MAX}.` },
			},
			required: ["machine"],
			additionalProperties: false,
		},
		annotations: { readOnlyHint: true, untrustedContentHint: true },
		prepare(input, lab) {
			const parsed = fieldsOf(name, input, ["machine", "lines"]);
			if (!parsed.ok) return { ok: false, line: asCalled(name, input), error: parsed.error };
			const machine = parsed.fields.get("machine");
			if (typeof machine !== "string") {
				return { ok: false, line: asCalled(name, input), error: `${name} needs the machine field, such as "node2".` };
			}
			const lines = wholeNumber(name, "lines", parsed.fields.get("lines"), SHELL_LINES, SHELL_MAX);
			if (typeof lines !== "number") return { ok: false, line: asCalled(name, input), error: lines.error };
			const line = `${name}(${machine}, ${lines})`;
			const read = target.read(machine, {
				verb: name,
				lab,
				phases: ["booting", "ready", "stopping", "off", "restoring", "failed"],
			});
			if (read instanceof slots.Miss) {
				return { ok: false, line, error: read.message ?? `${name} wants ${target.noun}, not ${machine}.` };
			}
			const session = sessionOf(read, lab);
			if (session === undefined) return { ok: false, line, error: `${machine} is gone, so list the machines again.` };
			return {
				ok: true,
				line,
				preview: `Will read the last ${lines} lines of ${session}.`,
				actionLabel: `Read ${session}`,
				async run() {
					const text = screens.get(session)?.lastLines(lines) ?? "";
					const shown = text === "" ? 0 : text.split("\n").length;
					const summary = shown === 0 ? `${session} shows nothing yet` : `${shown} lines from ${session}`;
					return { summary, reply: { session, text } };
				},
			};
		},
	};
}

const CAPTURE_LIMIT = 20;
const CAPTURE_MAX = 1000;

function captureRead(capture: Pick<CaptureView, "frames">): AgentTool {
	const name = "capture_read";
	return {
		name,
		title: "Read captured frames",
		description:
			"Read the newest frames the switches carried, as decoded rows, oldest first. In a lab of several switches a row has its switch, the port it came in by and those it went out of. A frame that a cable dropped has dropped: the cable's port and the reason (loss, rate or mtu). In the filter, lan is what that switch carried, lan:3 what crossed the cable in its port 3, port:3 that port of every switch, vlan 10 what was in VLAN 10, and stp the spanning tree's messages. Frames come from the guests.",
		inputSchema: {
			type: "object",
			properties: {
				filter: { ...slotSchema(slots.frameFilter()), default: "" },
				limit: { type: "integer", minimum: 1, default: CAPTURE_LIMIT, description: `At most ${CAPTURE_MAX}.` },
			},
			additionalProperties: false,
		},
		annotations: { readOnlyHint: true, untrustedContentHint: true },
		prepare(input, lab) {
			const parsed = fieldsOf(name, input, ["filter", "limit"]);
			if (!parsed.ok) return { ok: false, line: asCalled(name, input), error: parsed.error };
			const source = parsed.fields.get("filter") ?? "";
			if (typeof source !== "string") {
				return {
					ok: false,
					line: asCalled(name, input),
					error: `${name} wants filter as a string, not ${written(source)}.`,
				};
			}
			const limit = wholeNumber(name, "limit", parsed.fields.get("limit"), CAPTURE_LIMIT, CAPTURE_MAX);
			if (typeof limit !== "number") return { ok: false, line: asCalled(name, input), error: limit.error };
			const line = `${name}(${JSON.stringify(source)}, ${limit})`;
			const compiled = compileFilter(source, selectNames(lab));
			if (!compiled.ok) {
				return { ok: false, line, error: compiled.error.message };
			}
			const { filter } = compiled;
			const matching = source.trim() === "" ? "" : ` matching ${source.trim()}`;
			return {
				ok: true,
				line,
				preview: `Will read up to ${limit} captured frames${matching}.`,
				actionLabel: "Read the capture",
				async run() {
					const matched: FrameEntry[] = [];
					for (const frame of capture.frames()) {
						if (filter.matchesFrame(frame)) matched.push(frame);
					}
					// Decode only the rows the agent gets: a full buffer is ten thousand frames.
					const rows = matched.slice(-limit).flatMap((frame) => {
						const row = captureRow(frame, {
							severalNics: (machine) => severalNics(lab, machine),
							switchLabel: (on) => switchLabel(lab, on),
						});
						return row.kind === "frame" ? [row] : [];
					});
					const unanswered = rows.filter((row) => row.note?.includes("no reply")).length;
					const frames = `${rows.length} ${rows.length === 1 ? "frame" : "frames"}`;
					return { summary: unanswered === 0 ? frames : `${frames}, ${unanswered} with no reply`, reply: { rows } };
				},
			};
		},
	};
}
