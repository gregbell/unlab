// What the elements read. Each selector is memoised on the slices it uses, so
// it returns the same object until one of them changes and a subscriber can
// compare with Object.is.

import { addressStr, ip4str, LAB_SUBNET, type NameBook, NICS, nicName, subnetStr } from "../net/index.ts";
import { type Device, disksOf } from "./disks.ts";
import { nicLabel, nicMac, sessionLabel } from "./identity.ts";
import { ACCEPTS, type Accepts, addressOf, machineList, nameBook, nicPortsOf, plugsOf, portsOf } from "./machines.ts";
import { keyboardHolder, parkedPanes, visiblePanes } from "./panes.ts";
import { type Tiling, tile } from "./tiling.ts";
import {
	AGENT_IDLE_MS,
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
	SWITCH_NAME,
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
	(s) => [s.machines, s.rail, s.departed],
	(machines, rail, departed) => nameBook({ machines, rail, departed }),
);

/** The subnet the lab's addresses are in, or how many there are. A lab that has none yet starts in this one. */
export const selectSubnets: (state: LabState) => string = memo(
	(s) => [s.machines, s.rail],
	(machines, rail) => {
		const nics = machineList({ machines, rail }).flatMap((machine) => machine.spec.nics);
		const subnets = [...new Set(nics.flatMap(({ address }) => (address ? [subnetStr(address)] : [])))];
		if (subnets.length > 1) return plural(subnets.length, "subnet");
		return subnets[0] ?? subnetStr(LAB_SUBNET);
	},
);

export interface RailRow {
	readonly name: MachineName;
	readonly hue: HueNo;
	readonly phase: Phase;
	/** `10.88.0.12`, `10.88.0.12 · parked`, `no address`, `did not boot`. */
	readonly line2: string;
	/** State always has a word: `booting 1.4 s` while booting, the link state once ready, the phase after. */
	readonly word: LinkWord | `booting ${string} s` | "failed" | "removing";
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
				word:
					life.phase === "booting"
						? bootingFor(life.since, now)
						: (machineLink(machine) ?? (life.phase === "ready" ? "unplugged" : life.phase)),
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
	readonly ports: readonly PortNo[];
	/** One for each NIC, eth0 first. Empty unless the machine is ready. */
	readonly cables: readonly Cable[];
	/** Why it failed, as the runtime said it. */
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
	if (life.phase === "booting") return bootingFor(life.since, now);
	return life.phase === "ready" ? `ready · ${Math.round(life.bootMs)} ms` : life.phase;
}

function stateTone(machine: Machine): Pick<DetailRow, "tone"> {
	return machine.life.phase === "failed" ? { tone: "down" } : {};
}

function linkRow(label: "link" | NicName, { life }: Machine, nic: NicNo): DetailRow {
	if (life.phase === "removing" && life.ports[nic]) return { label, value: `port ${life.ports[nic]} down` };
	const plug = plugsOf(life)[nic];
	if (!plug || plug.kind === "none") return { label, value: "unplugged" };
	if (life.phase === "booting") return { label, value: `port ${plug.port} reserved` };
	if (plug.link === "cut") return { label, value: `cable cut on port ${plug.port}`, tone: "down" };
	return { label, value: `connected on port ${plug.port}`, tone: "ok" };
}

/** The only disk is the machine's own. Several are told apart by device. */
function diskRows({ spec }: Machine): DetailRow[] {
	const disks = disksOf(spec);
	return disks.map(({ device, gib }) => ({ label: disks.length === 1 ? "disk" : device, value: `${gib} GiB` }));
}

/** One NIC reads as the machine's own address and link. Several are told apart by name. */
function nicRows(machine: Machine): DetailRow[] {
	const { spec } = machine;
	const uplink: DetailRow[] = [
		{ label: "uplink", value: "lab only" },
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
	if (nics.length === 1) return [...facts(0), ...uplink, linkRow("link", machine, 0)];
	return [...uplink, ...nics.flatMap((nic) => [linkRow(nicName(nic), machine, nic), ...facts(nic)])];
}

function cables(machine: Machine): readonly Cable[] {
	if (machine.life.phase !== "ready") return [];
	const { plugs } = machine.life;
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
		return [machine, s.images, machine?.life.phase === "booting" ? s.now : 0];
	},
	(machine, images, now) => {
		if (!machine) return null;
		const image = images.find((known) => known.name === machine.spec.image);
		return {
			name: machine.name,
			hue: machine.hue,
			phase: machine.life.phase,
			ports: portsOf(machine.life),
			cables: cables(machine),
			reason: machine.life.phase === "failed" ? machine.life.reason : null,
			accepts: ACCEPTS[machine.life.phase],
			rows: [
				{ label: "state", value: stateValue(machine, now), ...stateTone(machine) },
				{ label: "image", value: image ? image.label : machine.spec.image },
				{ label: "CPUs", value: String(machine.spec.cpus ?? 1) },
				...diskRows(machine),
				{ label: "memory", value: `${machine.spec.memMiB} MiB` },
				...nicRows(machine),
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

export interface PortView {
	readonly port: PortNo;
	/** In `removing` the link is already down and the port frees when the machine is gone. */
	readonly state: "empty" | "booting" | "up" | "cut" | "removing";
	readonly machine: PortHolder | null;
	/** The word under the socket, one of `boot`, `up`, `cut`, `down`. An empty port shows only its number. */
	readonly word: string | null;
	/** What a click will do, for the button's accessible name. Null when a click does nothing. */
	readonly actionLabel: string | null;
}

function portView(port: PortNo, machine: Machine | undefined): PortView {
	if (!machine) return { port, state: "empty", machine: null, word: null, actionLabel: null };
	const { n, name, hue, life } = machine;
	const nic = NICS.find((k) => nicPortsOf(life)[k] === port) ?? 0;
	const label = nicLabel(machine, nic);
	const holder = { n, name, hue, label, nic: machine.spec.nics.length > 1 ? nicName(nic) : null };
	if (life.phase === "removing") return { port, state: "removing", machine: holder, word: "down", actionLabel: null };
	const plug = plugsOf(life)[nic];
	if (life.phase === "booting" || !plug)
		return { port, state: "booting", machine: holder, word: "boot", actionLabel: null };
	if (plugWord(plug) === "up") {
		const actionLabel = `Cut the cable from ${label} to port ${port}`;
		return { port, state: "up", machine: holder, word: "up", actionLabel };
	}
	const actionLabel = `Reconnect the cable from ${label} to port ${port}`;
	return { port, state: "cut", machine: holder, word: "cut", actionLabel };
}

/** The faceplate's eight ports, lowest first. */
export const selectPorts: (state: LabState) => readonly PortView[] = memo(
	(s) => [s.machines, s.rail],
	(machines, rail) => {
		const list = machineList({ machines, rail });
		return PORTS.map((port) =>
			portView(
				port,
				list.find((machine) => portsOf(machine.life).includes(port)),
			),
		);
	},
);

export interface LinkCount {
	readonly up: number;
	/** Cables plugged in, whether up, cut, or waiting for a boot. Those of a machine being removed no longer count. */
	readonly total: number;
	readonly cut: number;
}

/** The numbers in `2 of 3 links up`, for the faceplate header and the status line. */
export const selectLinks: (state: LabState) => LinkCount = memo(
	(s) => [s.machines, s.rail],
	(machines, rail) => {
		const plugged = machineList({ machines, rail }).flatMap(({ life }) =>
			plugsOf(life).flatMap((plug) =>
				plug.kind === "port" ? [{ ready: life.phase === "ready", link: plug.link }] : [],
			),
		);
		return {
			up: plugged.filter((cable) => cable.ready && cable.link === "up").length,
			total: plugged.length,
			cut: plugged.filter((cable) => cable.ready && cable.link === "cut").length,
		};
	},
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
	readonly key: "machines" | "sessions" | "links" | "webmcp";
	readonly text: string;
	/** `quiet` when all is well, `down` for a failed machine or a cut cable, `warn` while a call waits or the browser blocks the tools. */
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
	const parts = [`${count("ready")} of ${plural(total, "machine")} ready`];
	if (count("booting") > 0) parts.push(`${count("booting")} booting`);
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

export const selectStatus: (state: LabState) => StatusLine = memo(
	(s) => [s.machines, s.rail, s.sessions, s.agent, selectAgentIndicator(s), selectLinks(s)],
	(machines, rail, sessions, agent, indicator, links) => {
		const list = machineList({ machines, rail });
		const live = list.filter((machine) => machine.life.phase === "booting" || machine.life.phase === "ready");
		const open = live.flatMap((machine) => machine.sessions).filter((id) => sessions[id]?.state === "open").length;
		const left: StatusSegment[] = [
			machinesSegment(list),
			{ key: "sessions", text: `${open} open ${open === 1 ? "session" : "sessions"}`, tone: "quiet" },
		];
		if (links.total > 0) {
			const text = `${SWITCH_NAME}: ${links.up} of ${plural(links.total, "link")} up`;
			left.push({ key: "links", text, tone: links.cut > 0 ? "down" : "quiet" });
		}
		return {
			left,
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
