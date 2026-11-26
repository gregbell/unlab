// What the elements read. Each selector is memoised on the slices it uses, so
// it returns the same object until one of them changes and a subscriber can
// compare with Object.is.

import { addressStr, ip4str, LAB_SUBNET, type NameBook, NICS, nicName, subnetStr } from "../net/index.ts";
import { type Device, disksOf, sizeText } from "./disks.ts";
import { nicLabel, nicMac, sessionLabel } from "./identity.ts";
import {
	ACCEPTS,
	type Accepts,
	addressOf,
	type HeldPort,
	heldPorts,
	holdsNic,
	machineList,
	nameBook,
	nicPortsOf,
	plugsOf,
	portsOf,
	savingOf,
} from "./machines.ts";
import { keyboardHolder, parkedPanes, visiblePanes } from "./panes.ts";
import { portLabel, portName, switchLabel } from "./switches.ts";
import { type Tiling, tile } from "./tiling.ts";
import {
	AGENT_IDLE_MS,
	DEFAULT_SWITCH,
	type HueNo,
	type LabState,
	type LogEntry,
	type Machine,
	type MachineName,
	type NicName,
	type NicNo,
	type Phase,
	type Plug,
	PORTS,
	type PortNo,
	type PortRef,
	type Storm,
	type SwitchName,
} from "./types.ts";
import { clockHz } from "./update.ts";

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

/** The clock, for selectors that show a boot counter. Still while nothing boots, so they do not wake on every tick. */
const bootClock = (state: LabState): number => (clockHz(state) === 10 ? state.now : 0);

const plural = (count: number, one: string): string => `${count} ${one}${count === 1 ? "" : "s"}`;

/** Counted in tenths and rounded down, so the counter never shows time that has not passed. */
function bootingFor(since: number, now: number): `booting ${string} s` {
	const tenths = Math.max(0, Math.floor((now - since) / 100));
	return `booting ${(tenths / 10).toFixed(1)} s`;
}

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

export type StateWord =
	| LinkWord
	| `booting ${string} s`
	| `restoring ${number}%`
	| "powering off"
	| "rebooting"
	| "off"
	| "failed"
	| "removing";

function stateWord(machine: Machine, now: number): StateWord {
	const { life } = machine;
	switch (life.phase) {
		case "booting":
			return bootingFor(life.since, now);
		case "ready":
			return machineLink(machine) ?? "unplugged";
		case "stopping":
			return life.next === "off" ? "powering off" : "rebooting";
		case "restoring":
			return `restoring ${life.percent}%`;
		default:
			return life.phase;
	}
}

export interface RailRow {
	readonly name: MachineName;
	readonly hue: HueNo;
	readonly phase: Phase;
	/** `10.88.0.12`, `10.88.0.12 · parked`, `no address`, `did not boot`. */
	readonly line2: string;
	/** State always has a word: `booting 1.4 s` while booting, the link state once ready, and one of its own in any other. */
	readonly word: StateWord;
	readonly focused: boolean;
	readonly parked: boolean;
}

export const selectRail: (state: LabState) => readonly RailRow[] = memo(
	(s) => [s.machines, s.rail, s.panes.parked, selectFocused(s), bootClock(s)],
	(machines, rail, parked, focused, now) =>
		machineList({ machines, rail }).map((machine): RailRow => {
			const { life, name } = machine;
			const isParked = parked[name] !== undefined;
			const line2 = life.phase === "failed" ? "did not boot" : addressText(machine);
			return {
				name,
				hue: machine.hue,
				phase: life.phase,
				line2: isParked ? `${line2} · parked` : line2,
				word: stateWord(machine, now),
				focused: name === focused,
				parked: isParked,
			};
		}),
);

export interface DetailRow {
	readonly label:
		| "state"
		| "image"
		| "CPUs"
		| "disk"
		| Device
		| "checkpoints"
		| "memory"
		| "address"
		| "mac"
		| "gateway"
		| "uplink"
		| "link"
		| "shells"
		| NicName;
	readonly value: string;
	readonly tone?: "ok" | "down";
}

/** A cable the cut and reconnect action works on. */
export interface Cable {
	/** What `link up` and `link down` call it: `node2`, or `node2:eth1` when the machine has more than one. */
	readonly label: string;
	/** The NIC to tell it apart by, or null when it is the machine's only one. */
	readonly nic: NicName | null;
	readonly link: LinkWord;
}

export interface MachineDetails {
	readonly name: MachineName;
	readonly hue: HueNo;
	readonly phase: Phase;
	/** The ports its cables hold or have reserved. The element reads the ports' frame counters with them. */
	readonly ports: readonly PortRef[];
	/** One for each NIC, eth0 first. Empty unless the machine takes them now. */
	readonly cables: readonly Cable[];
	/** The switch that `link up` plugs an unplugged NIC into, to name when the lab has several. */
	readonly plugsInto: SwitchName | null;
	/** Why it failed, or could not save the last checkpoint, as the runtime said it. */
	readonly reason: string | null;
	readonly accepts: Accepts;
	/**
	 * In the handoff's order, without `frames`. Those counters are the switch's,
	 * so the element puts that row in before `shells`.
	 */
	readonly rows: readonly DetailRow[];
}

function stateValue(machine: Machine, now: number): string {
	const { life } = machine;
	if (life.phase === "ready") return `ready · ${Math.round(life.bootMs)} ms`;
	if (life.phase === "off" && machine.lastStop === "forced") return "off · did not shut down";
	return stateWord(machine, now);
}

function stateTone(machine: Machine): Pick<DetailRow, "tone"> {
	return machine.life.phase === "failed" ? { tone: "down" } : {};
}

function linkRow(lab: Pick<LabState, "switches">, label: "link" | NicName, { life }: Machine, nic: NicNo): DetailRow {
	if (life.phase === "removing" && life.ports[nic]) return { label, value: `${portLabel(lab, life.ports[nic])} down` };
	const plug = plugsOf(life)[nic];
	if (!plug || plug.kind === "none") return { label, value: "unplugged" };
	const port = portLabel(lab, plug.port);
	if (life.phase === "booting") return { label, value: `${port} reserved` };
	if (life.phase === "ready" && life.lost?.includes(nic))
		return { label, value: "gone from the guest until it reboots", tone: "down" };
	if (plug.link === "cut") return { label, value: `cable cut on ${port}`, tone: "down" };
	if (life.phase === "off" || life.phase === "restoring") return { label, value: `plugged into ${port}` };
	return { label, value: `connected on ${port}`, tone: "ok" };
}

/** The only disk is the machine's own. Several are told apart by device. */
function diskRows({ spec }: Machine): DetailRow[] {
	const disks = disksOf(spec);
	return disks.map(({ device, gib }) => ({ label: disks.length === 1 ? "disk" : device, value: `${gib} GiB` }));
}

/** `before 12.5 MiB, after 13.0 MiB · 25.5 MiB in all`, and one that is being saved. */
function checkpointRows({ sets, life }: Machine): DetailRow[] {
	const { checkpoints } = sets;
	const saving = savingOf(life);
	const parts = [
		checkpoints.map(({ name, bytes }) => `${name} ${sizeText(bytes)}`).join(", "),
		checkpoints.length > 1 ? `${sizeText(checkpoints.reduce((sum, { bytes }) => sum + bytes, 0))} in all` : "",
		saving ? `saving ${saving.name} ${saving.percent}%` : "",
	].filter(Boolean);
	return parts.length === 0 ? [] : [{ label: "checkpoints", value: parts.join(" · ") }];
}

const UPLINK = { none: "lab only", packages: "package repositories", internet: "internet through the CLI" } as const;

/** One NIC reads as the machine's own address and link. Several are told apart by name. */
function nicRows(lab: Pick<LabState, "switches" | "cli">, machine: Machine): DetailRow[] {
	const { spec } = machine;
	const reach = gatewayReach(lab, machine);
	const uplink: DetailRow[] = [
		{ label: "uplink", value: UPLINK[reach ?? "none"] },
		...(spec.gateway ? [] : [{ label: "gateway", value: "off" } as const]),
	];
	const nics = NICS.slice(0, spec.nics.length);
	const facts = (nic: NicNo): DetailRow[] => {
		const { address } = spec.nics[nic];
		return [
			{ label: "address", value: address ? addressStr(address) : "none" },
			{ label: "mac", value: nicMac(machine.n, nic) },
		];
	};
	if (nics.length === 1) return [...facts(0), ...uplink, linkRow(lab, "link", machine, 0)];
	return [...uplink, ...nics.flatMap((nic) => [linkRow(lab, nicName(nic), machine, nic), ...facts(nic)])];
}

function cables(machine: Machine): readonly Cable[] {
	if (!ACCEPTS[machine.life.phase].cables) return [];
	const plugs = plugsOf(machine.life);
	return NICS.slice(0, plugs.length).map((nic) => ({
		label: nicLabel(machine, nic),
		nic: plugs.length > 1 ? nicName(nic) : null,
		link: plugWord(plugs[nic]),
	}));
}

/** The details panel under the rail shows the machine that has the keyboard. */
export const selectDetails: (state: LabState) => MachineDetails | null = memo(
	(s) => {
		const focused = selectFocused(s);
		const machine = focused === null ? undefined : s.machines[focused];
		return [machine, s.images, s.switches, s.cli, machine?.life.phase === "booting" ? s.now : 0];
	},
	(machine, images, switches, cli, now) => {
		if (!machine) return null;
		const image = images.find((known) => known.name === machine.spec.image);
		return {
			name: machine.name,
			hue: machine.hue,
			phase: machine.life.phase,
			ports: portsOf(machine.life),
			cables: cables(machine),
			plugsInto: switchLabel({ switches }, DEFAULT_SWITCH),
			reason: machine.life.phase === "failed" ? machine.life.reason : (machine.unsaved?.reason ?? null),
			accepts: ACCEPTS[machine.life.phase],
			rows: [
				{ label: "state", value: stateValue(machine, now), ...stateTone(machine) },
				{ label: "image", value: image ? image.label : machine.spec.image },
				{ label: "CPUs", value: String(machine.spec.cpus ?? 1) },
				...diskRows(machine),
				...checkpointRows(machine),
				{ label: "memory", value: `${machine.spec.memMiB} MiB` },
				...nicRows({ switches, cli }, machine),
				{ label: "shells", value: machine.sessions.map(sessionLabel).join(", ") },
			],
		};
	},
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
	/** The word under the socket, one of `boot`, `up`, `cut`, `stop`, `off`, `down`. An empty port shows only its number. */
	readonly word: string | null;
	/** What a click will do, for the button's accessible name. Null when a click does nothing. */
	readonly actionLabel: string | null;
}

function portView(lab: Pick<LabState, "switches">, ref: PortRef, held: HeldPort | undefined): PortView {
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

/** A switch's eight ports, lowest first. */
export const selectPorts = perSwitch((on) =>
	memo(
		(s) => [s.machines, s.rail, s.switches, s.switchCables],
		(machines, rail, switches, switchCables): readonly PortView[] => {
			const held = heldPorts({ machines, rail, switchCables }, on);
			return PORTS.map((port) =>
				portView(
					{ switches },
					{ switch: on, port },
					held.find((taken) => taken.port === port),
				),
			);
		},
	),
);

export interface LinkCount {
	readonly up: number;
	/** Cables plugged in, whether up, cut, or waiting for a boot. Those of a machine being removed no longer count. */
	readonly total: number;
	readonly cut: number;
}

/** The numbers in `2 of 3 links up`, for a switch's header and the panel bar. */
export const selectLinks = perSwitch((on) =>
	memo(
		(s) => [s.machines, s.rail, s.switchCables],
		(machines, rail, switchCables): LinkCount => {
			const nics = machineList({ machines, rail }).flatMap(({ life }) =>
				plugsOf(life).flatMap((plug) =>
					plug.kind === "port" && plug.port.switch === on ? [{ ready: life.phase === "ready", link: plug.link }] : [],
				),
			);
			// A cable between switches is a link at each port it is in, and no machine keeps it down.
			const between = switchCables.flatMap(({ ends, link }) =>
				ends.flatMap((end) => (end.switch === on ? [{ ready: true, link }] : [])),
			);
			const plugged = [...nics, ...between];
			return {
				up: plugged.filter((cable) => cable.ready && cable.link === "up").length,
				total: plugged.length,
				cut: plugged.filter((cable) => cable.ready && cable.link === "cut").length,
			};
		},
	),
);

/** The lab's, on every switch. */
export const selectAllLinks: (state: LabState) => LinkCount = memo(
	(s) => s.switches.map((on) => selectLinks(on)(s)),
	(...links) => ({
		up: links.reduce((n, { up }) => n + up, 0),
		total: links.reduce((n, { total }) => n + total, 0),
		cut: links.reduce((n, { cut }) => n + cut, 0),
	}),
);

/** The switch's storm, or null while no frame comes back to it. */
export const selectStorm = perSwitch(
	(on) =>
		(state: LabState): Storm | null =>
			state.storms[on] ?? null,
);

/** Unchanged by a focus, because focusing never moves a pane. */
export const selectTiling: (state: LabState) => Tiling = memo(
	(s) => [s.panes.order, s.panes.parked, s.panes.grid],
	(order, parked, grid) => tile(visiblePanes({ order, parked }), grid),
);

/** The parked strip, in pane order. Empty means the strip is absent. */
export const selectParkedChips: (state: LabState) => readonly MachineName[] = memo(
	(s) => [s.panes.order, s.panes.parked],
	(order, parked) => parkedPanes({ order, parked }),
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

export interface StatusLine {
	readonly left: readonly StatusSegment[];
	readonly right: readonly StatusSegment[];
}

function machinesSegment(machines: readonly Machine[]): StatusSegment {
	const count = (phase: Phase): number => machines.filter((machine) => machine.life.phase === phase).length;
	const total = machines.length - count("removing");
	if (total === 0) return { key: "machines", text: "0 machines", tone: "quiet" };
	const parts = [`${count("ready")} of ${total} ready`];
	if (count("booting") > 0) parts.push(`${count("booting")} booting`);
	if (count("restoring") > 0) parts.push(`${count("restoring")} restoring`);
	if (count("stopping") > 0) parts.push(`${count("stopping")} stopping`);
	if (count("off") > 0) parts.push(`${count("off")} off`);
	if (count("failed") > 0) parts.push(`${count("failed")} failed`);
	return { key: "machines", text: parts.join(", "), tone: count("failed") > 0 ? "down" : "quiet" };
}

function webmcpSegment(agent: LabState["agent"], indicator: AgentIndicator): StatusSegment {
	const waiting = agent.calls.filter((call) => call.status === "waiting").length;
	if (waiting > 0) return { key: "webmcp", text: `webmcp: ${plural(waiting, "call")} waiting for you`, tone: "warn" };
	if (agent.webmcp.kind === "absent") return { key: "webmcp", text: "webmcp: not available", tone: "quiet" };
	if (agent.webmcp.kind === "refused") return { key: "webmcp", text: "webmcp: blocked", tone: "warn" };
	if (agent.paused) return { key: "webmcp", text: "webmcp: paused", tone: "quiet" };
	const tools = plural(Object.values(agent.policies).filter((policy) => policy !== "off").length, "tool");
	const text = indicator === "no agent calls yet" ? `webmcp: ${tools} registered` : `webmcp: ${tools}, ${indicator}`;
	return { key: "webmcp", text, tone: "quiet" };
}

/** The link with the CLI, which the status line shows beside WebMCP. */
export function selectCliSegment({ cli }: LabState): StatusSegment {
	return CLI_SEGMENTS[cli.kind];
}

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

export const selectStatus: (state: LabState) => StatusLine = memo(
	(s) => [s.machines, s.rail, s.sessions, s.agent, selectAgentIndicator(s)],
	(machines, rail, sessions, agent, indicator) => {
		const list = machineList({ machines, rail });
		const live = list.filter((machine) => machine.life.phase === "booting" || machine.life.phase === "ready");
		const open = live.flatMap((machine) => machine.sessions).filter((id) => sessions[id]?.state === "open").length;
		return {
			left: [machinesSegment(list), { key: "sessions", text: plural(open, "session"), tone: "quiet" }],
			right: [webmcpSegment(agent, indicator)],
		};
	},
);

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
