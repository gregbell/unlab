import { isPlanError, MAX_MACHINES, type MachineName, planSpawn } from "../../model/index.ts";
import { defineVerb, refuse } from "../define.ts";
import * as slots from "../grammar/slots.ts";
import { andList, imageLabel, planErrorSentence, ports } from "./words.ts";

export const spawn = defineVerb({
	name: "spawn",
	about: "boot machines",
	danger: false,
	grammar: {
		count: slots.count({ suggest: (lab) => [1, 2, 3].filter((n) => n <= MAX_MACHINES - lab.rail.length) }),
		image: slots.image(),
		mem: slots.option(
			"--mem",
			slots.count({ label: "MiB", noun: "a size in MiB", suggest: () => [128, 256, 512, 1024] }),
			256,
		),
		net: slots.exclusive<"switch0" | "none">("switch0", [
			slots.valued("--net", slots.choice(["switch0"])),
			slots.flag("--no-net", "none"),
		]),
	},
	plan(a, lab) {
		const plan = planSpawn(lab, a.count, { image: a.image, memMiB: a.mem, net: a.net });
		return isPlanError(plan)
			? refuse(planErrorSentence(plan), plan.kind === "unknown-image" ? "image" : "count")
			: plan;
	},
	describe(plan, lab) {
		const { machines, spec } = plan;
		const many = machines.length > 1;
		const plugged = machines.flatMap((m) => (m.port === null ? [] : [m.port]));
		return [
			`boot ${andList(machines.map((m) => m.identity.name))}`,
			imageLabel(lab, spec.image),
			`${spec.memMiB} MiB${many ? " each" : ""}`,
			spec.net === "none" ? "unplugged" : `plugged into switch0 on ${ports(plugged)}`,
		].join(" · ");
	},
	async execute(plan, ctx, deps) {
		deps.dispatch({ type: "cmd/spawn", plan, at: deps.now() });
		const names = plan.machines.map((m) => m.identity.name);
		await deps.until((s) => names.every((name) => s.machines[name] !== undefined), ctx.signal);
		return { kind: "visible", text: `booting ${andList(names)}`, data: { names } satisfies SpawnData };
	},
	tool: {
		name: "machines_spawn",
		description:
			"Boot new Linux machines on the lab's switch. Returns the names created. Each boots on its own and takes commands once ready.",
		policy: "ask",
	},
});

export interface SpawnData {
	readonly names: readonly MachineName[];
}
