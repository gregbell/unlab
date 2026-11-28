// What the elements read. Each selector is memoised on the slices it uses, so
// it returns the same object until one of them changes and a subscriber can
// compare with Object.is.

import { ip4str, LAB_SUBNET, type NameBook, nicName, subnetStr } from "../net/index.ts";
import { conditionWords, hasConditions } from "./conditions.ts";
import { nicLabel } from "./identity.ts";
import {
	addressOf,
	type HeldPort,
	heldPorts,
	holdsNic,
	machineList,
	nameBook,
	nicPortsOf,
	plugsOf,
} from "./machines.ts";
import { keyboardHolder } from "./panes.ts";
import { costOf, treePortAt } from "./stp.ts";
import { portLabel, portName } from "./switches.ts";
import {
	AGENT_IDLE_MS,
	DEFAULT_COST,
	type HueNo,
	type LabState,
	type LogEntry,
	type Machine,
	type MachineName,
	type NicName,
	type PathCost,
	type Plug,
	PORTS,
	type PortNo,
	type PortRef,
	type Storm,
	type SwitchName,
	type TreePort,
} from "./types.ts";
import { vlanOf, vlanText } from "./vlans.ts";

function memo<const Inputs extends readonly unknown[], Out>(
	inputs: (state: LabState) => Inputs,
	compute: (...inputs: Inputs) => Out,
): (state: LabState) => Out {
	let last: { readonly inputs: Inputs; readonly out: Out } | null = null;
	return (state) => {
		const next = inputs(state);
		const hit = last;
		if (hit && next.every((value, i) => Object.is(value, hit.inputs[i]))) return hit.out;
		const out = compute(...next);
		last = { inputs: next, out };
		return out;
	};
}

/** A selector for each switch, each memoised by itself. */
function perSwitch<Out>(
	make: (on: SwitchName) => (state: LabState) => Out,
): (on: SwitchName) => (state: LabState) => Out {
	const made = new Map<SwitchName, (state: LabState) => Out>();
	return (on) => {
		const select = made.get(on) ?? make(on);
		made.set(on, select);
		return select;
	};
}

const plural = (count: number, one: string): string => `${count} ${one}${count === 1 ? "" : "s"}`;

/** The machine with the keyboard. While the command bar is open, the one it returns to. */
export const selectFocused = (state: LabState): MachineName | null => keyboardHolder(state.keyboard);

export type LinkWord = "up" | "cut" | "unplugged";

const plugWord = (plug: Plug): LinkWord => (plug.kind === "none" ? "unplugged" : plug.link);

/** The machine's links in one word, or null unless it is ready. One cut cable among several is what there is to say. */
export function machineLink({ life }: Pick<Machine, "life">): LinkWord | null {
	if (life.phase !== "ready") return null;
	const words = life.plugs.map(plugWord);
	return (["cut", "up"] as const).find((word) => words.includes(word)) ?? "unplugged";
}

/** `10.88.0.12`, or `no address` for a machine the lab set none on. */
export function addressText(machine: Pick<Machine, "spec">): string {
	const address = addressOf(machine);
	return address ? ip4str(address.ip) : "no address";
}

/** Who is who in the lab now, for naming what a frame's bytes point at. */
export const selectNames: (state: LabState) => NameBook = memo(
	(s) => [s.machines, s.rail, s.departed, s.switches, s.departedSwitches],
	(machines, rail, departed, switches, departedSwitches) =>
		nameBook({ machines, rail, departed, switches, departedSwitches }),
);

/**
 * The subnet the lab's addresses are in, or how many there are. A lab that has
 * none yet starts in this one. Of several switches, each has only those of the
 * NICs plugged into it.
 */
export const selectSubnets = perSwitch((on) =>
	memo(
		(s) => [s.machines, s.rail, s.switches],
		(machines, rail, switches): string => {
			const several = switches.length > 1;
			const addresses = machineList({ machines, rail }).flatMap(({ spec, life }) => {
				const ports = nicPortsOf(life);
				return spec.nics.flatMap(({ address }, nic) =>
					address && (!several || ports[nic]?.switch === on) ? [address] : [],
				);
			});
			const subnets = [...new Set(addresses.map(subnetStr))];
			if (subnets.length > 1) return plural(subnets.length, "subnet");
			return subnets[0] ?? (several ? "no addresses" : subnetStr(LAB_SUBNET));
		},
	),
);

export interface PortHolder {
	readonly n: number;
	readonly name: MachineName;
	readonly hue: HueNo;
	/** What `link up` and `link down` call the cable: `node2`, or `node2:eth1` when the machine has more than one NIC. */
	readonly label: string;
	/** The NIC to tell it apart by, or null when it is the machine's only one. */
	readonly nic: NicName | null;
}

/** What a port carries, when that is not VLAN 1. */
export interface PortVlanView {
	/** On the cable's tag: `v10`, or `trunk`. */
	readonly tag: string;
	/** `vlan 10`, `trunk of 10 and 20, native 1`. */
	readonly text: string;
}

/** The other end of a cable between switches, and what commands call the cable from this end. */
export interface PortCable {
	readonly to: PortRef;
	/** `lan:3`, which `link` and `uncable` take. */
	readonly label: string;
}

export interface PortView {
	readonly port: PortNo;
	/** In `off` the cable is in and the link is down. In `removing` it is down too and the port frees when the machine is gone. */
	readonly state: "empty" | "booting" | "up" | "cut" | "stopping" | "off" | "removing";
	readonly machine: PortHolder | null;
	/** There when the port's cable goes to another port of a switch. */
	readonly cable?: PortCable;
	/** There when the port is not in VLAN 1. A free port always is. */
	readonly vlan?: PortVlanView;
	/** The conditions of the cable in it, there when it has some: `delay 100 ms, loss 20%`. */
	readonly conditions?: string;
	/** What it is in its switch's spanning tree, there while the switch has spanning tree on and the port's link is up. */
	readonly tree?: TreePort;
	/** What it adds to the way to the root through it, there when it is not 20000. */
	readonly cost?: PathCost;
	/** The word under the socket, one of `boot`, `up`, `cut`, `stop`, `off`, `down`. An empty port shows only its number. */
	readonly word: string | null;
	/** What a click will do, for the button's accessible name. Null when a click does nothing. */
	readonly actionLabel: string | null;
}

/** What a cable with conditions is marked with where there is room for one word. */
export const IMPAIRED = "impaired";

function portView(lab: Pick<LabState, "switches">, ref: PortRef, held: HeldPort | undefined): PortView {
	const view = cableView(lab, ref, held);
	return held && hasConditions(held.conditions)
		? { ...view, conditions: conditionWords(held.conditions).join(", ") }
		: view;
}

function cableView(lab: Pick<LabState, "switches">, ref: PortRef, held: HeldPort | undefined): PortView {
	const { port } = ref;
	if (!held) return { port, state: "empty", machine: null, word: null, actionLabel: null };
	if (!holdsNic(held)) {
		const between = `the cable from ${portLabel(lab, ref)} to ${portLabel(lab, held.far)}`;
		const actionLabel = held.link === "up" ? `Cut ${between}` : `Reconnect ${between}`;
		const cable: PortCable = { to: held.far, label: portName(ref) };
		return { port, state: held.link, machine: null, cable, word: held.link, actionLabel };
	}
	const { machine, nic } = held;
	const { n, name, hue, life } = machine;
	const label = nicLabel(machine, nic);
	const holder = { n, name, hue, label, nic: machine.spec.nics.length > 1 ? nicName(nic) : null };
	if (life.phase === "removing") return { port, state: "removing", machine: holder, word: "down", actionLabel: null };
	const plug = plugsOf(life)[nic];
	if (life.phase === "booting" || life.phase === "restoring" || !plug)
		return { port, state: "booting", machine: holder, word: "boot", actionLabel: null };
	if (life.phase === "stopping") return { port, state: "stopping", machine: holder, word: "stop", actionLabel: null };
	if (plugWord(plug) === "up") {
		const actionLabel = `Cut the cable from ${label} to ${portLabel(lab, ref)}`;
		const word = life.phase === "off" ? "off" : "up";
		return { port, state: word, machine: holder, word, actionLabel };
	}
	const actionLabel = `Reconnect the cable from ${label} to ${portLabel(lab, ref)}`;
	return { port, state: "cut", machine: holder, word: "cut", actionLabel };
}

function vlanView(portVlans: LabState["portVlans"], ref: PortRef): PortVlanView | undefined {
	const vlan = vlanOf({ portVlans }, ref);
	if (vlan.mode === "access" && vlan.vlan === 1) return undefined;
	return { tag: vlan.mode === "access" ? `v${vlan.vlan}` : "trunk", text: vlanText(vlan) };
}

/** A switch's eight ports, lowest first. */
export const selectPorts = perSwitch((on) =>
	memo(
		(s) => [s.machines, s.rail, s.switches, s.switchCables, s.portVlans, s.trees, s.portCosts],
		(machines, rail, switches, switchCables, portVlans, trees, portCosts): readonly PortView[] => {
			const held = heldPorts({ machines, rail, switchCables }, on);
			return PORTS.map((port) => {
				const ref = { switch: on, port };
				const view = portView(
					{ switches },
					ref,
					held.find((taken) => taken.port === port),
				);
				const vlan = vlanView(portVlans, ref);
				const tree = treePortAt({ trees }, ref);
				const cost = costOf({ portCosts }, ref);
				return {
					...view,
					...(vlan ? { vlan } : {}),
					...(tree ? { tree } : {}),
					...(cost === DEFAULT_COST ? {} : { cost }),
				};
			});
		},
	),
);

/** The switch's storm, or null while no frame comes back to it. */
export const selectStorm = perSwitch(
	(on) =>
		(state: LabState): Storm | null =>
			state.storms[on] ?? null,
);

export type AgentIndicator = "no agent calls yet" | "agent active" | "agent idle";

/** WebMCP cannot say who is calling or whether anyone is attached, so this is all the UI may claim. */
export function selectAgentIndicator(state: LabState): AgentIndicator {
	const { lastCallAt } = state.agent;
	if (lastCallAt === null) return "no agent calls yet";
	return state.now - lastCallAt < AGENT_IDLE_MS ? "agent active" : "agent idle";
}

export interface StatusSegment {
	readonly key: "machines" | "sessions" | "webmcp" | "cli";
	readonly text: string;
	/** `quiet` when all is well, `down` for a failed machine, `warn` while a call waits or the browser blocks the tools. */
	readonly tone: "quiet" | "down" | "warn";
}

/** The link with the CLI, which SSH access shows, and an agent that uses the lab through it. */
export function selectCliSegment(state: LabState): StatusSegment {
	const { cli, agent } = state;
	const throughCli = agent.calls.at(-1)?.via === "cli" && selectAgentIndicator(state) === "agent active";
	return cli.kind === "linked" && throughCli ? CLI_AGENT_ACTIVE : CLI_SEGMENTS[cli.kind];
}

const CLI_AGENT_ACTIVE: StatusSegment = { key: "cli", text: "cli: linked, agent active", tone: "quiet" };

const CLI_SEGMENTS: Readonly<Record<LabState["cli"]["kind"], StatusSegment>> = {
	off: { key: "cli", text: "cli: off", tone: "quiet" },
	waiting: { key: "cli", text: "cli: waiting", tone: "quiet" },
	blocked: { key: "cli", text: "cli: blocked", tone: "warn" },
	refused: { key: "cli", text: "cli: refused", tone: "warn" },
	linked: { key: "cli", text: "cli: linked", tone: "quiet" },
};

/** What a machine's gateway reaches now, or null for one that has none. */
export function gatewayReach({ cli }: Pick<LabState, "cli">, { spec }: Machine): "packages" | "internet" | null {
	if (!spec.gateway) return null;
	return cli.kind === "linked" ? "internet" : "packages";
}

/** The last three lines run from the bar or by the agent, newest first. Button clicks would crowd it. */
export const selectRecent: (state: LabState) => readonly LogEntry[] = memo(
	(s) => [s.log],
	(log) =>
		log
			.filter((entry) => entry.source !== "button")
			.slice(-3)
			.reverse(),
);

/** Lines typed in the bar, newest first. The up arrow walks back through them. */
export const selectBarHistory: (state: LabState) => readonly string[] = memo(
	(s) => [s.log],
	(log) =>
		log
			.filter((entry) => entry.source === "bar")
			.map((entry) => entry.line)
			.reverse(),
);
