import {
	isPlanError,
	type LabState,
	type LinkChange,
	type MachineName,
	type PortNo,
	planLink,
} from "../../model/index.ts";
import { defineVerb, refuse } from "../define.ts";
import * as slots from "../grammar/slots.ts";
import { andList, planErrorSentence, ports, skippedPart } from "./words.ts";

/** A machine's cable as `link_set` reports it. */
export interface CableState {
	readonly machine: MachineName;
	readonly port: PortNo | null;
	readonly link: "up" | "cut" | "unplugged";
}

function cable(lab: LabState, machine: MachineName): CableState | null {
	const life = lab.machines[machine]?.life;
	if (life?.phase !== "ready") return null;
	return life.plug.kind === "port"
		? { machine, port: life.plug.port, link: life.plug.link }
		: { machine, port: null, link: "unplugged" };
}

function applied(lab: LabState, change: LinkChange): boolean {
	const now = cable(lab, change.machine);
	return now !== null && now.port === change.port && (now.link === "up") === change.up;
}

type Kind = "cut" | "reconnect" | "plug";

const KINDS: readonly Kind[] = ["cut", "reconnect", "plug"];

const PHRASE: Readonly<Record<Kind, (names: string, where: string, many: boolean) => string>> = {
	cut: (names, where, many) => `cut the ${many ? "cables" : "cable"} to ${names} on ${where}`,
	reconnect: (names, where) => `reconnect ${names} on ${where}`,
	plug: (names, where) => `plug ${names} into ${where}`,
};

function kindOf(change: LinkChange): Kind {
	if (!change.up) return "cut";
	return change.newPort ? "plug" : "reconnect";
}

export const link = defineVerb({
	name: "link",
	about: "plug or cut cables",
	danger: false,
	grammar: { link: slots.choice(["up", "down"]), machines: slots.machines() },
	plan(a, lab) {
		const up = a.link === "up";
		const changes = planLink(lab, a.machines.machines, up);
		if (isPlanError(changes)) return refuse(planErrorSentence(changes), "machines");
		const changing = new Set(changes.map((c) => c.machine));
		const unchanged = a.machines.machines.filter((m) => !changing.has(m) && cable(lab, m) !== null);
		return { up, changes, unchanged, skipped: a.machines.skipped };
	},
	describe(plan) {
		const parts = KINDS.flatMap((kind) => {
			const group = plan.changes.filter((c) => kindOf(c) === kind);
			if (group.length === 0) return [];
			return [PHRASE[kind](andList(group.map((c) => c.machine)), ports(group.map((c) => c.port)), group.length > 1)];
		});
		if (plan.unchanged.length > 0) {
			const are = plan.unchanged.length === 1 ? "is" : "are";
			const lead = parts.length === 0 ? "change nothing: " : "";
			parts.push(`${lead}${andList(plan.unchanged)} ${are} already ${plan.up ? "up" : "cut"}`);
		}
		return [...parts, ...skippedPart(plan.skipped)].join(" · ");
	},
	async execute(plan, ctx, deps) {
		deps.dispatch({ type: "cmd/link", changes: plan.changes, cause: ctx.source });
		const settled = await deps.until((s) => plan.changes.every((c) => applied(s, c)), ctx.signal);
		const cables = [...plan.changes.map((c) => c.machine), ...plan.unchanged].flatMap((m) => cable(settled, m) ?? []);
		const text = cables.map((c) => `${c.machine} ${c.link}`).join(", ");
		return { kind: "visible", text: [text, ...skippedPart(plan.skipped)].join(" · "), data: cables };
	},
	tool: {
		name: "link_set",
		title: "Plug in or cut cables",
		description:
			"Plug in (up) or cut (down) the switch cable of machines. Returns the port and link state per machine. A machine already as asked is left alone.",
		policy: "run",
	},
});
