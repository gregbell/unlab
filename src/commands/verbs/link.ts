import {
	ACCEPTS,
	type CableChange,
	CONDITION_PARTS,
	type Conditions,
	type ConditionsChange,
	type ConditionValues,
	cableAt,
	conditionsAt,
	conditionWords,
	DEFAULT_SWITCH,
	endsFrom,
	hasConditions,
	isConditionsFault,
	isPlanError,
	joined,
	type LabState,
	type Lifecycle,
	type LinkChange,
	type MachineName,
	type NicName,
	type NicNo,
	type NicRef,
	NO_CONDITIONS,
	nicLabel,
	nicPortsOf,
	type PortNo,
	type PortRef,
	planLink,
	plugsOf,
	portName,
	type SwitchName,
	sameConditions,
	samePort,
	type WrittenConditions,
	withConditions,
	writtenConditions,
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
	/** The cable's, each part as an option takes it. There when the line set or cleared conditions. */
	readonly conditions?: WrittenConditions;
}

/** A cable between two switches as `link_set` reports it, from the port that named it. */
export interface SwitchCableState extends PortRef {
	readonly to: PortRef;
	readonly link: "up" | "cut";
	/** As a NIC's cable has them. */
	readonly conditions?: WrittenConditions;
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

/** A cable that the line gives conditions: the port it will be in, what a sentence calls it, and what it is to have. */
interface Conditioned extends ConditionsChange {
	/** `node2`, or `lan port 3 to wan port 1` for one between switches. */
	readonly to: string | null;
	readonly between: string | null;
	readonly was: Conditions;
}

/** `delay 100 ms and loss 20%`, or `no conditions`. */
function conditionsText(conditions: Conditions): string {
	return hasConditions(conditions) ? andList(conditionWords(conditions)) : "no conditions";
}

/** `the cables to node1 and node2`, `the cable from lan port 3 to wan port 1`. */
function cablesText(cables: readonly Conditioned[]): string {
	const nics = cables.flatMap(({ to }) => to ?? []);
	const between = cables.flatMap((cable) => (cable.between === null ? [] : [`the cable from ${cable.between}`]));
	const to = nics.length === 0 ? [] : [`the ${nics.length === 1 ? "cable" : "cables"} to ${andList(nics)}`];
	return andList([...to, ...between]);
}

/** What the line will do to conditions, a part for each set of cables that end up alike. */
function conditionParts(cables: readonly Conditioned[], nothing: string): string[] {
	const changed = cables.filter(({ was, conditions }) => !sameConditions(was, conditions));
	const parts = [...Map.groupBy(changed, ({ conditions }) => conditionsText(conditions))].map(([text, group]) =>
		hasConditions(group[0].conditions)
			? `give ${cablesText(group)} ${text}`
			: `clear the conditions of ${cablesText(group)}`,
	);
	const kept = cables.filter(({ was, conditions }) => sameConditions(was, conditions));
	const prefix = parts.length === 0 ? nothing : "";
	for (const [text, group] of Map.groupBy(kept, ({ conditions }) => conditionsText(conditions))) {
		parts.push(`${prefix}${cablesText(group)} already ${group.length === 1 ? "has" : "have"} ${text}`);
	}
	return parts;
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
	about: "plug or cut cables, and set their conditions",
	description: `Plug in (up) or cut (down) the cables of machines or of single NICs. A port names the cable in it (lan:3), also one between switches. One already as asked is left alone. An unplugged NIC goes into the lowest free port of ${DEFAULT_SWITCH}. A machine that is off takes it too: its links come up when it boots. The options set the cables' conditions, alike in both directions: one left out stays, and a cut, a move or a reboot keeps them. Returns each cable's port and link, and with an option its conditions.`,
	danger: false,
	phases: ["ready", "off"],
	grammar: {
		link: slots.choice("up plugs the cables in, down cuts them.", ["up", "down"]),
		machines: slots.cables(),
		delay: slots.option("--delay", slots.condition("delay"), null),
		loss: slots.option("--loss", slots.condition("loss"), null),
		reorder: slots.option("--reorder", slots.condition("reorder"), null),
		rate: slots.option("--rate", slots.condition("rate"), null),
		mtu: slots.option("--mtu", slots.condition("mtu"), null),
		conditions: slots.exclusive(
			"--clear takes every condition of the cables away, before those that the other options set.",
			"keep",
			[slots.flag("--clear", "clear")],
		),
	},
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
		const plan = { up, changes, unchanged, cables, turned, skipped: a.machines.skipped };

		const values: ConditionValues = Object.fromEntries(
			CONDITION_PARTS.flatMap((part) => (a[part] === null ? [] : [[part, a[part]]])),
		);
		const clear = a.conditions === "clear";
		if (!clear && Object.keys(values).length === 0) return { ...plan, conditioned: null };
		// Every cable that the line names, where it will be once the line has run.
		const named: Omit<Conditioned, "conditions">[] = [];
		const held = unchanged.map((ref) => {
			const life = lab.machines[ref.machine]?.life;
			return { ref, port: life && nicPortsOf(life)[ref.nic], fresh: false };
		});
		for (const { ref, port, fresh } of [
			...changes.map((ref) => ({ ref, port: ref.port, fresh: ref.newPort })),
			...held,
		]) {
			const to = label(lab, ref);
			if (!port) return refuse(`${to} has no cable to give conditions, so plug it in with link up ${to}.`, "machines");
			named.push({ port, to, between: null, was: fresh ? NO_CONDITIONS : conditionsAt(lab, port) });
		}
		for (const { to, ...port } of cables) {
			named.push({ port, to: null, between: cableLabel(lab, [port, to]), was: conditionsAt(lab, port) });
		}
		const conditioned: Conditioned[] = [];
		for (const cable of named) {
			const conditions = withConditions(clear ? NO_CONDITIONS : cable.was, values);
			if (isConditionsFault(conditions)) {
				const whose = cable.to ?? `the cable from ${cable.between}`;
				if (conditions.kind !== "reorder-needs-delay") return refuse(`${whose} cannot have that ${conditions.part}.`);
				// Reordering that was there is at fault only when this line takes the delay away.
				return a.reorder !== null && a.reorder > 0
					? refuse(
							`Reordering lets frames skip a cable's delay, and ${whose} has none, so give --delay too, such as --delay 20ms.`,
							"reorder",
						)
					: refuse(
							`${whose} reorders frames by letting them skip its delay, so keep the delay, or take both away with --delay 0 --reorder 0.`,
							"delay",
						);
			}
			conditioned.push({ ...cable, conditions });
		}
		return { ...plan, conditioned };
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
		const conditioned = plan.conditioned ?? [];
		const sets = conditioned.some(({ was, conditions }) => !sameConditions(was, conditions));
		const nothing = parts.length === 0 && !sets ? "change nothing: " : "";
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
		const said = conditionParts(conditioned, parts.length === 0 ? nothing : "");
		return [...parts, ...said, ...skippedPart(plan.skipped)].join(" · ");
	},
	async execute(plan, ctx, deps) {
		const turned: readonly CableChange[] = plan.turned.map(({ switch: on, port }) => ({
			port: { switch: on, port },
			up: plan.up,
		}));
		deps.dispatch({ type: "cmd/link", changes: plan.changes, cause: ctx.source });
		if (turned.length > 0) deps.dispatch({ type: "cmd/cable-link", changes: turned, cause: ctx.source });
		const conditioned = plan.conditioned ?? [];
		// After the links, so a cable that this line plugs in is there to take them.
		if (conditioned.length > 0) {
			const changes = conditioned.map(({ port, conditions }) => ({ port, conditions }));
			deps.dispatch({ type: "cmd/conditions", changes });
		}
		const settled = await deps.until(
			(s) =>
				plan.changes.every((c) => applied(s, c)) &&
				turned.every(({ port }) => (cableAt(s, port)?.link === "up") === plan.up) &&
				conditioned.every(({ port, conditions }) => sameConditions(conditionsAt(s, port), conditions)),
			ctx.signal,
		);
		/** What a cable has now, said and returned when the line was about conditions. */
		const had = (port: PortRef | null | undefined) => {
			if (plan.conditioned === null || !port) return { text: "", data: {} };
			const conditions = conditionsAt(settled, port);
			return { text: ` with ${conditionsText(conditions)}`, data: { conditions: writtenConditions(conditions) } };
		};
		const cables = [...plan.changes, ...plan.unchanged].flatMap((ref) => {
			const now = cable(settled, ref);
			if (!now) return [];
			const life = settled.machines[ref.machine]?.life;
			const has = had(life && nicPortsOf(life)[ref.nic]);
			const link = now.link === "off" ? "plugged in" : now.link;
			return [{ now: { ...now, ...has.data }, text: `${label(settled, ref)} ${link}${has.text}` }];
		});
		const switched = plan.cables.flatMap((port) => {
			const now = between(settled, port);
			if (!now) return [];
			const has = had(port);
			return [{ now: { ...now, ...has.data }, text: `${portName(port)} ${now.link}${has.text}` }];
		});
		const all = [...cables, ...switched];
		const text = all.map((c) => c.text).join(", ");
		return { kind: "visible", text: [text, ...skippedPart(plan.skipped)].join(" · "), data: all.map((c) => c.now) };
	},
	tool: {
		name: "link_set",
		title: "Plug in or cut cables, and set their conditions",
		policy: "run",
	},
});
