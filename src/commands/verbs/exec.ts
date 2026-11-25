import {
	ALL_MACHINES,
	type HueNo,
	type LabState,
	type Machine,
	type MachineName,
	machineList,
	type Phase,
	parseSessionId,
	type SessionId,
} from "../../model/index.ts";
import { defineVerb, refuse } from "../define.ts";
import { globMatch } from "../grammar/glob.ts";
import * as slots from "../grammar/slots.ts";
import type { ReportBlock } from "../types.ts";
import { andList, count } from "./words.ts";

/** What exec was asked to type into, as read: a machine means its active session when the line runs. */
export interface ExecTargets {
	readonly picks: readonly Picked[];
	readonly skipped: readonly Skip[];
	readonly written: string;
}

interface Picked {
	readonly machine: MachineName;
	readonly hue: HueNo;
	/** Null for the machine's active session. */
	readonly session: SessionId | null;
}

interface Skip {
	/** As the line or the expansion named it. */
	readonly target: MachineName | SessionId;
	readonly machine: MachineName;
	readonly hue: HueNo;
	readonly reason: string;
}

interface Target {
	readonly machine: MachineName;
	readonly hue: HueNo;
	readonly session: SessionId;
	/** How the preview names it: the machine for its active session, the session when one was asked for. */
	readonly label: string;
}

const NOT_READY: Readonly<Record<Exclude<Phase, "ready">, string>> = {
	booting: "still booting",
	stopping: "stopping",
	restoring: "being restored",
	off: "off",
	failed: "failed",
	removing: "being removed",
};
const BUSY = "running a program";

function youHave(lab: LabState): string {
	return lab.rail.length === 0 ? "The lab has no machines yet." : `You have ${lab.rail.join(", ")}.`;
}

/**
 * Machines (`node2`, `node1,node3`, `node*`, `all`) and sessions
 * (`node2:sh1`), in one comma list. Machines that are not ready are skipped,
 * as `slots.machines` skips them; a session names itself, so its machine must
 * be ready.
 */
function consoles(): slots.Value<ExecTargets> {
	const machines = slots.machines();
	const target = slots.target();
	return {
		kind: "positional",
		label: "machines",
		noun: "machines or sessions",
		read(text, ctx) {
			const picks: Picked[] = [];
			const skipped: Skip[] = [];
			const all = machineList(ctx.lab);
			const add = (m: Machine, session: SessionId | null) => {
				if (!picks.some((p) => p.machine === m.name && p.session === session)) {
					picks.push({ machine: m.name, hue: m.hue, session });
				}
			};
			const pick = (m: Machine) => {
				if (m.life.phase === "ready") add(m, null);
				else if (!skipped.some((s) => s.target === m.name)) {
					skipped.push({ target: m.name, machine: m.name, hue: m.hue, reason: NOT_READY[m.life.phase] });
				}
			};
			let start = 0;
			for (const part of text.split(",")) {
				const span = { start, end: start + part.length };
				start = span.end + 1;
				if (part === "") return new slots.Miss(undefined, span);
				if (part.includes(":")) {
					const read = target.read(part, ctx);
					if (read instanceof slots.Miss) {
						const at = read.part ?? { start: 0, end: part.length };
						const where = { start: span.start + at.start, end: span.start + at.end };
						return new slots.Miss(read.message, where, read.fixable);
					}
					const address = parseSessionId(read);
					const m = address && all.find((one) => one.name === address.machine);
					if (address && m) add(m, address.session);
				} else if (part === ALL_MACHINES) {
					all.forEach(pick);
				} else if (part.includes("*")) {
					const matched = all.filter((m) => globMatch(part, m.name));
					if (matched.length === 0) return new slots.Miss(`No machine matches ${part}. ${youHave(ctx.lab)}`, span);
					matched.forEach(pick);
				} else {
					const m = all.find((one) => one.name === part);
					if (!m) return new slots.Miss(`No machine called ${part}. ${youHave(ctx.lab)}`, span);
					pick(m);
				}
			}
			if (picks.length === 0) {
				const why = skipped.length === 0 ? youHave(ctx.lab) : `Skipped ${skippedText(skipped)}.`;
				return new slots.Miss(`exec has no machine to type into. ${why}`, undefined, false);
			}
			return { picks, skipped, written: text };
		},
		suggest(typed, ctx) {
			const comma = typed.lastIndexOf(",");
			const part = typed.slice(comma + 1);
			const colon = part.indexOf(":");
			if (colon < 0) return machines.suggest(typed, ctx);
			const head = typed.slice(0, comma + 1);
			const machine = part.slice(0, colon);
			return target
				.suggest(part, ctx)
				.filter((s) => s.insert.startsWith(`${machine}:`))
				.map((s) => ({ ...s, insert: head + s.insert }));
		},
		format: (t) => t.written,
		schema: {
			type: "string",
			description:
				"Where to type: a machine (node2) for its active session, a session (node2:sh1), a comma list of either, a glob (node*) or all.",
		},
	};
}

function skippedText(skipped: readonly Skip[]): string {
	return skipped.map((s) => `${s.target}: ${s.reason}`).join(", ");
}

/** The plan's targets, resolved against the lab now: a bare machine is its active session, a busy session is skipped. */
function resolve(read: ExecTargets, lab: LabState): { targets: Target[]; skipped: Skip[] } {
	const targets: Target[] = [];
	const skipped: Skip[] = [...read.skipped];
	for (const pick of read.picks) {
		const { machine, hue } = pick;
		const named = pick.session ?? machine;
		const m = lab.machines[machine];
		const reason = !m ? "gone" : m.life.phase === "ready" ? null : NOT_READY[m.life.phase];
		if (!m || reason !== null) {
			skipped.push({ target: named, machine, hue, reason: reason ?? "gone" });
			continue;
		}
		const session = pick.session ?? m.activeSession;
		const shell = lab.sessions[session]?.shell;
		if (shell === undefined || shell === "running") {
			skipped.push({ target: session, machine, hue, reason: shell ? BUSY : "that session has closed" });
			continue;
		}
		if (!targets.some((t) => t.session === session)) targets.push({ machine, hue, session, label: named });
	}
	return { targets, skipped };
}

/** One line typed into one session, as `shell_exec` returns it. */
export interface ExecRun {
	readonly session: SessionId;
	readonly exitCode: number | null;
	readonly output: string;
	/** There was more before `output`. */
	readonly truncated: boolean;
	readonly ms: number;
}

export interface ExecData {
	readonly ran: readonly ExecRun[];
	readonly skipped: readonly { readonly target: MachineName | SessionId; readonly reason: string }[];
}

/** The most characters of a run's output that `data` carries: an agent reads all of it. */
const OUTPUT_MAX = 16_000;

/** The last whole lines that fit: part of a line reads as a different one, `7334` for `17334`. */
function tail(output: string): string {
	if (output.length <= OUTPUT_MAX) return output;
	const kept = output.slice(-OUTPUT_MAX);
	if (output.at(-OUTPUT_MAX - 1) === "\n") return kept;
	const lineEnd = kept.indexOf("\n");
	return lineEnd === -1 ? kept : kept.slice(lineEnd + 1);
}

export const exec = defineVerb({
	name: "exec",
	about: "run a shell command in each console",
	danger: false,
	grammar: { targets: consoles(), command: slots.passthrough("command") },
	plan(a, lab) {
		const { targets, skipped } = resolve(a.targets, lab);
		if (targets.length === 0)
			return refuse(`exec has nothing to type into. Skipped ${skippedText(skipped)}.`, "targets");
		return { command: a.command, targets, skipped };
	},
	describe(plan) {
		const skipped = plan.skipped.length === 0 ? [] : [`skipped ${skippedText(plan.skipped)}`];
		return [`run \`${plan.command}\` in ${andList(plan.targets.map((t) => t.label))}`, ...skipped].join(" · ");
	},
	async execute(plan, ctx, deps) {
		const started = deps.now();
		const settled = await Promise.allSettled(
			plan.targets.map((t) => deps.exec.inject(t.session, plan.command, ctx.source, ctx.signal)),
		);
		ctx.signal.throwIfAborted();
		const seconds = ((deps.now() - started) / 1000).toFixed(1);

		const ran: ExecRun[] = [];
		const busy: Skip[] = [];
		const blocks: ReportBlock[] = [];
		settled.forEach((outcome, i) => {
			const t = plan.targets[i];
			if (outcome.status === "rejected") {
				const reason = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
				busy.push({ target: t.session, machine: t.machine, hue: t.hue, reason });
				return;
			}
			const { exitCode, output, truncated, lastLine, ms } = outcome.value;
			ran.push({
				session: t.session,
				exitCode,
				output: tail(output),
				truncated: truncated || output.length > OUTPUT_MAX,
				ms,
			});
			blocks.push({
				machine: t.machine,
				hue: t.hue,
				status: exitCode === null ? { kind: "unknown" } : { kind: "exit", code: exitCode },
				lastLine,
				focus: t.session,
			});
		});
		const skipped = [...busy, ...plan.skipped];
		for (const s of skipped) {
			blocks.push({
				machine: s.machine,
				hue: s.hue,
				status: { kind: "skipped", reason: s.reason },
				lastLine: "",
				focus: null,
			});
		}

		const failed = ran.filter((r) => r.exitCode !== null && r.exitCode !== 0).length;
		const header = [
			`ran in ${count(ran.length, "console")} in ${seconds} s`,
			...(failed > 0 ? [`${failed} failed`] : []),
		];
		const data: ExecData = { ran, skipped: skipped.map(({ target, reason }) => ({ target, reason })) };
		return { kind: "report", header: header.join(" · "), blocks, data };
	},
	tool: {
		name: "shell_exec",
		title: "Run a shell command",
		description:
			"Type a shell command into machines' sessions, as a person would, and wait for each to finish. Returns each exit code and output. Long output keeps only its end and has truncated set. The output comes from the guests.",
		policy: "run",
		annotations: { untrustedContentHint: true },
	},
});
