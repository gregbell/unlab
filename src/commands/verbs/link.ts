import {
	ACCEPTS,
	isPlanError,
	type LabState,
	type Lifecycle,
	type LinkChange,
	type MachineName,
	type NicName,
	type NicNo,
	type NicRef,
	nicLabel,
	nicPortsOf,
	type PortNo,
	planLink,
	plugsOf,
	samePort,
} from "../../model/index.ts";
import { nicName } from "../../net/index.ts";
import { defineVerb, machineNow, Refusal, refuse } from "../define.ts";
import * as slots from "../grammar/slots.ts";
import { andList, planErrorSentence, ports, skippedPart } from "./words.ts";

/** `off` for a cable that is in, on a machine that is off: its link comes up when the machine boots. */
export type CableLink = "up" | "cut" | "unplugged" | "off";

/** One NIC's cable as `link_set` reports it. */
export interface CableState {
	readonly machine: MachineName;
	readonly nic: NicName;
	readonly port: PortNo | null;
	readonly link: CableLink;
}

/** Null while the machine takes no change to its cables. */
export function cableLink(life: Lifecycle, nic: NicNo): CableLink | null {
	const plug = ACCEPTS[life.phase].cables ? plugsOf(life)[nic] : undefined;
	if (!plug) return null;
	if (plug.kind === "none") return "unplugged";
	return plug.link === "up" && life.phase === "off" ? "off" : plug.link;
}

function cable(lab: LabState, { machine, nic }: NicRef): CableState | null {
	const life = lab.machines[machine]?.life;
	const link = life ? cableLink(life, nic) : null;
	return life && link ? { machine, nic: nicName(nic), port: nicPortsOf(life)[nic]?.port ?? null, link } : null;
}

/** The cable as a person names it: `node2`, or `node2:eth1` when the machine has more than one. */
function label(lab: LabState, { machine, nic }: NicRef): string {
	const m = lab.machines[machine];
	return m ? nicLabel(m, nic) : machine;
}

function applied(lab: LabState, change: LinkChange): boolean {
	const life = lab.machines[change.machine]?.life;
	const plug = life && ACCEPTS[life.phase].cables ? plugsOf(life)[change.nic] : undefined;
	return plug?.kind === "port" && samePort(plug.port, change.port) && (plug.link === "up") === change.up;
}

const same = (a: NicRef, b: NicRef): boolean => a.machine === b.machine && a.nic === b.nic;

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
	description:
		"Plug in (up) or cut (down) the switch cables of machines or of single NICs. Returns the port and link state per NIC. A cable already as asked is left alone. A machine that is off can be unplugged or plugged in; its link comes up when it boots.",
	danger: false,
	phases: ["ready", "off"],
	grammar: { link: slots.choice("up plugs the cables in, down cuts them.", ["up", "down"]), machines: slots.cables() },
	example: { link: "down", machines: "node2" },
	plan(a, lab, ctx) {
		for (const { machine } of a.machines.nics) {
			const now = machineNow(machine, ctx, "machines");
			if (now instanceof Refusal) return now;
		}
		const up = a.link === "up";
		const changes = planLink(lab, a.machines.nics, up);
		if (isPlanError(changes)) return refuse(planErrorSentence(changes), "machines");
		const unchanged = a.machines.nics.filter((ref) => !changes.some((c) => same(c, ref)) && cable(lab, ref) !== null);
		return { up, changes, unchanged, skipped: a.machines.skipped };
	},
	describe(plan, lab) {
		const names = (refs: readonly NicRef[]) => andList(refs.map((ref) => label(lab, ref)));
		const parts = KINDS.flatMap((kind) => {
			const group = plan.changes.filter((c) => kindOf(c) === kind);
			if (group.length === 0) return [];
			return [PHRASE[kind](names(group), ports(group.map((c) => c.port.port)), group.length > 1)];
		});
		if (plan.unchanged.length > 0) {
			const are = plan.unchanged.length === 1 ? "is" : "are";
			const lead = parts.length === 0 ? "change nothing: " : "";
			parts.push(`${lead}${names(plan.unchanged)} ${are} already ${plan.up ? "up" : "cut"}`);
		}
		const off = [...new Set(plan.changes.map((c) => c.machine))].filter(
			(name) => lab.machines[name]?.life.phase === "off",
		);
		if (off.length > 0) parts.push(`${andList(off)} ${off.length === 1 ? "is" : "are"} off`);
		return [...parts, ...skippedPart(plan.skipped)].join(" · ");
	},
	async execute(plan, ctx, deps) {
		deps.dispatch({ type: "cmd/link", changes: plan.changes, cause: ctx.source });
		const settled = await deps.until((s) => plan.changes.every((c) => applied(s, c)), ctx.signal);
		const cables = [...plan.changes, ...plan.unchanged].flatMap((ref) => {
			const now = cable(settled, ref);
			return now ? [{ now, text: `${label(settled, ref)} ${now.link === "off" ? "plugged in" : now.link}` }] : [];
		});
		const text = cables.map((c) => c.text).join(", ");
		return { kind: "visible", text: [text, ...skippedPart(plan.skipped)].join(" · "), data: cables.map((c) => c.now) };
	},
	tool: {
		name: "link_set",
		title: "Plug in or cut cables",
		policy: "run",
	},
});
