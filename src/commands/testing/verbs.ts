import { type LabState, type LinkChange, MAX_MACHINES, type MachineName, type SessionId } from "../../model/types.ts";
import { defineVerb, type ParsedLine, refuse } from "../define.ts";
import * as slots from "../grammar/slots.ts";
import { createRegistry } from "../index.ts";
import { isLineError, type LineError } from "../types.ts";
import { fakeDeps } from "./lab.ts";

// Toy verbs that exercise every slot kind. Their plans are stand-ins for the
// model's planners, just enough to show validate, preview and run re-planning.

function names(list: readonly string[]): string {
	return list.length < 2 ? list.join("") : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

export const link = defineVerb({
	name: "link",
	about: "Plugs in or cuts cables",
	danger: false,
	grammar: { dir: slots.choice(["up", "down"]), targets: slots.machines() },
	plan(a, lab) {
		const changes: LinkChange[] = [];
		for (const name of a.targets.machines) {
			const m = lab.machines[name];
			if (m?.life.phase !== "ready") return refuse(`${name} is no longer ready.`, "targets");
			if (m.life.plug.kind === "port") {
				changes.push({ machine: name, up: a.dir === "up", port: m.life.plug.port, newPort: false });
			}
		}
		return { changes, skipped: a.targets.skipped };
	},
	describe: (p) =>
		p.changes
			.map((c) => `${c.up ? "plug" : "cut the cable from"} ${c.machine} ${c.up ? "into" : "to"} port ${c.port}`)
			.join(" · "),
	async execute(plan, ctx, deps) {
		deps.dispatch({ type: "cmd/link", changes: plan.changes, cause: ctx.source });
		return { kind: "visible", text: "", data: plan.changes };
	},
	tool: { name: "link_set", policy: "run" },
});

export const spawn = defineVerb({
	name: "spawn",
	about: "Boots machines",
	danger: false,
	grammar: {
		count: slots.count({ suggest: () => [1, 2, 3] }),
		image: slots.image(),
		mem: slots.option(
			"--mem",
			slots.count({ label: "MiB", noun: "a size in MiB", suggest: () => [128, 256, 512] }),
			256,
		),
		net: slots.exclusive<"switch0" | "none">("switch0", [
			slots.valued("--net", slots.choice(["switch0"])),
			slots.flag("--no-net", "none"),
		]),
	},
	plan(a, lab) {
		const plugged = lab.rail.filter((n) => {
			const life = lab.machines[n]?.life;
			return life?.phase === "removing" ? life.port !== null : life?.phase !== "failed" && life?.plug.kind === "port";
		});
		const free = MAX_MACHINES - plugged.length;
		if (a.net === "switch0" && free < a.count) {
			return refuse(`switch0 has ${free} free ports. Add --no-net to boot them unplugged.`, "count");
		}
		const made = Array.from({ length: a.count }, (_, i): MachineName => `node${lab.nextN + i}`);
		return { names: made, image: a.image, memMiB: a.mem, net: a.net };
	},
	describe: (p) => `boot ${names(p.names)} · ${p.image} · ${p.memMiB} MiB`,
	async execute(plan, _ctx, deps) {
		deps.dispatch({
			type: "cmd/spawn",
			plan: { machines: [], spec: { image: plan.image, memMiB: plan.memMiB, net: plan.net } },
			at: deps.now(),
		});
		return { kind: "visible", text: `booting ${plan.names.join(", ")}`, data: { names: plan.names } };
	},
	tool: { name: "machines_spawn", policy: "ask" },
});

export const rm = defineVerb({
	name: "rm",
	about: "Removes machines and their disks",
	danger: true,
	phases: ["booting", "ready", "failed"],
	grammar: { targets: slots.machines() },
	plan(a, lab) {
		const gone = a.targets.machines.find((n) => !lab.machines[n] || lab.machines[n]?.life.phase === "removing");
		if (gone) return refuse(`${gone} is already gone.`, "targets");
		return { machines: a.targets.machines };
	},
	describe: (p) => `remove ${names(p.machines)} and ${p.machines.length > 1 ? "their disks" : "its disk"}`,
	confirm: (p) => ({
		question: `Remove ${names(p.machines)}?`,
		detail: p.machines.length > 1 ? "Their disks go with them." : "Its disk goes with it.",
		actionLabel: `Remove ${names(p.machines)}`,
	}),
	async execute(plan, ctx, deps) {
		deps.dispatch({ type: "cmd/remove", machines: plan.machines, cause: ctx.source });
		await deps.until((s) => plan.machines.every((m) => !s.machines[m]), ctx.signal);
		return { kind: "visible", text: `removed ${plan.machines.join(", ")}`, data: { removed: plan.machines } };
	},
	tool: { name: "machines_remove", policy: "ask", annotations: { consequentialHint: true } },
});

export const exec = defineVerb({
	name: "exec",
	about: "Runs a shell command in each machine's active session",
	danger: false,
	grammar: { targets: slots.machines(), command: slots.passthrough("command") },
	plan: (a) => ({ machines: a.targets.machines, command: a.command }),
	describe: (p) => `type \`${p.command}\` into ${names(p.machines)}`,
	async execute(plan) {
		return { kind: "report", header: `ran in ${plan.machines.length} consoles`, blocks: [], data: null };
	},
	tool: { name: "shell_exec", policy: "run", annotations: { untrustedContentHint: true } },
});

export const focus = defineVerb({
	name: "focus",
	about: "Moves the keyboard",
	danger: false,
	grammar: {
		target: slots.target(),
		mode: slots.exclusive<"plain" | "main" | "max">("plain", [
			slots.flag("--main", "main"),
			slots.flag("--max", "max"),
		]),
	},
	plan: (a): { target: MachineName | SessionId; mode: "plain" | "main" | "max" } => a,
	describe: (p) => `focus ${p.target}`,
	async execute(plan, _ctx, deps) {
		deps.dispatch({ type: "cmd/focus", target: plan.target, mode: plan.mode });
		return { kind: "visible", text: "", data: null };
	},
});

export const capture = defineVerb({
	name: "capture",
	about: "Sets the capture filter and opens Wire",
	danger: false,
	grammar: { filter: slots.text("filter") },
	plan: (a) => ({ filter: a.filter }),
	describe: (p) => (p.filter ? `show frames matching ${p.filter}` : "show every frame"),
	async execute(plan, _ctx, deps) {
		deps.dispatch({ type: "cmd/capture", filter: plan.filter });
		return { kind: "visible", text: "", data: null };
	},
});

export const boot = defineVerb({
	name: "boot",
	about: "Boots a failed machine again",
	danger: false,
	phases: ["failed"],
	grammar: { machine: slots.machine() },
	plan: (a) => ({ machine: a.machine }),
	describe: (p) => `boot ${p.machine} again`,
	async execute(plan, _ctx, deps) {
		deps.dispatch({ type: "cmd/boot-again", machine: plan.machine, port: null, at: deps.now() });
		return { kind: "visible", text: "", data: null };
	},
});

export const ls = defineVerb({
	name: "ls",
	about: "Lists machines",
	danger: false,
	grammar: {},
	plan: (_a, lab) => ({ machines: lab.rail }),
	describe: () => "list the machines",
	async execute(plan) {
		return { kind: "report", header: `${plan.machines.length} machines`, blocks: [], data: plan.machines };
	},
	tool: { name: "machines_list", policy: "run", annotations: { readOnlyHint: true } },
});

export const TOY_VERBS = [spawn, rm, ls, exec, link, capture, focus, boot] as const;

export function toyRegistry(lab: LabState) {
	const fake = fakeDeps(lab);
	return { ...fake, registry: createRegistry(fake.deps, TOY_VERBS) };
}

/** Narrows parseLine's result for a test that expects the line to parse. */
export function parsedOk(result: ParsedLine | LineError): ParsedLine {
	if (isLineError(result)) throw new Error(`expected the line to parse: ${result.message}`);
	return result;
}
