import {
	ACCEPTS,
	type CableChange,
	cableAt,
	DEFAULT_SWITCH,
	endsFrom,
	isPlanError,
	joined,
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
	type PortRef,
	planLink,
	plugsOf,
	portName,
	type SwitchName,
	samePort,
} from "../../model/index.ts";
import { nicName } from "../../net/index.ts";
import { defineVerb, machineNow, Refusal, refuse } from "../define.ts";
import * as slots from "../grammar/slots.ts";
import { cableLabel, LOOP } from "./cable.ts";
import { andList, planErrorSentence, portOf, portsOn, skippedPart } from "./words.ts";

/** `off` for a cable that is in, on a machine that is off: its link comes up when the machine boots. */
export type CableLink = "up" | "cut" | "unplugged" | "off";

/** One NIC's cable as `link_set` reports it. */
export interface CableState {
	readonly machine: MachineName;
	readonly nic: NicName;
	/** The port's, when the lab has several. */
	readonly switch?: SwitchName;
	readonly port: PortNo | null;
	readonly link: CableLink;
}

/** A cable between two switches as `link_set` reports it, from the port that named it. */
export interface SwitchCableState extends PortRef {
	readonly to: PortRef;
	readonly link: "up" | "cut";
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
	return life && link ? { machine, nic: nicName(nic), ...portOf(lab, nicPortsOf(life)[nic]), link } : null;
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

/** The cable between switches that the port names, as it is now. Null once it is gone. */
function between(lab: LabState, port: PortRef): SwitchCableState | null {
	const held = cableAt(lab, port);
	return held ? { ...port, to: endsFrom(held, port)[1], link: held.link } : null;
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
	description: `Plug in (up) or cut (down) the switch cables of machines or of single NICs. Returns the port and link state per NIC, with the port's switch when the lab has several. A cable already as asked is left alone. A NIC that is unplugged goes into the lowest free port of ${DEFAULT_SWITCH}, and plug puts it in any. The cables of a machine that is off can be cut or plugged in; their links come up when it boots. A port names the cable in it (lan:3), also one between switches.`,
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
		// One that has gone since the line was read is left out, as a NIC that takes no change is.
		const cables = a.machines.between.flatMap((port) => between(lab, port) ?? []);
		const turned = cables.filter((now) => (now.link === "up") !== up);
		return { up, changes, unchanged, cables, turned, skipped: a.machines.skipped };
	},
	describe(plan, lab) {
		const names = (refs: readonly NicRef[]) => andList(refs.map((ref) => label(lab, ref)));
		const parts = KINDS.flatMap((kind) => {
			const group = plan.changes.filter((c) => kindOf(c) === kind);
			if (group.length === 0) return [];
			return [
				PHRASE[kind](
					names(group),
					portsOn(
						lab,
						group.map((c) => c.port),
					),
					group.length > 1,
				),
			];
		});
		for (const { to, ...port } of plan.turned) {
			const loop = plan.up && joined(lab, port.switch, to.switch) ? [LOOP] : [];
			parts.push(`${plan.up ? "reconnect" : "cut"} the cable from ${cableLabel(lab, [port, to])}`, ...loop);
		}
		const nothing = parts.length === 0 ? "change nothing: " : "";
		const as = plan.up ? "up" : "cut";
		if (plan.unchanged.length > 0) {
			const are = plan.unchanged.length === 1 ? "is" : "are";
			parts.push(`${nothing}${names(plan.unchanged)} ${are} already ${as}`);
		}
		for (const { to, ...port } of plan.cables.filter((now) => !plan.turned.includes(now))) {
			parts.push(`${nothing}the cable from ${cableLabel(lab, [port, to])} is already ${as}`);
		}
		const off = [...new Set(plan.changes.map((c) => c.machine))].filter(
			(name) => lab.machines[name]?.life.phase === "off",
		);
		if (off.length > 0) parts.push(`${andList(off)} ${off.length === 1 ? "is" : "are"} off`);
		return [...parts, ...skippedPart(plan.skipped)].join(" · ");
	},
	async execute(plan, ctx, deps) {
		const turned: readonly CableChange[] = plan.turned.map(({ switch: on, port }) => ({
			port: { switch: on, port },
			up: plan.up,
		}));
		deps.dispatch({ type: "cmd/link", changes: plan.changes, cause: ctx.source });
		if (turned.length > 0) deps.dispatch({ type: "cmd/cable-link", changes: turned, cause: ctx.source });
		const settled = await deps.until(
			(s) =>
				plan.changes.every((c) => applied(s, c)) &&
				turned.every(({ port }) => (cableAt(s, port)?.link === "up") === plan.up),
			ctx.signal,
		);
		const cables = [...plan.changes, ...plan.unchanged].flatMap((ref) => {
			const now = cable(settled, ref);
			return now ? [{ now, text: `${label(settled, ref)} ${now.link === "off" ? "plugged in" : now.link}` }] : [];
		});
		const switched = plan.cables.flatMap((port) => {
			const now = between(settled, port);
			return now ? [{ now, text: `${portName(port)} ${now.link}` }] : [];
		});
		const all = [...cables, ...switched];
		const text = all.map((c) => c.text).join(", ");
		return { kind: "visible", text: [text, ...skippedPart(plan.skipped)].join(" · "), data: all.map((c) => c.now) };
	},
	tool: {
		name: "link_set",
		title: "Plug in or cut cables",
		policy: "run",
	},
});
