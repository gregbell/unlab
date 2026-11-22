// What the elements read. Each selector is memoised on the slices it uses, so
// it returns the same object until one of them changes and a subscriber can
// compare with Object.is.

import { LAB_PREFIX_BITS, sessionLabel } from "./identity.ts";
import { ACCEPTS, type Accepts, machineList, portOf } from "./machines.ts";
import { keyboardHolder, parkedPanes, visiblePanes } from "./panes.ts";
import { type Tiling, tile } from "./tiling.ts";
import {
	AGENT_IDLE_MS,
	type HueNo,
	type LabState,
	type LogEntry,
	type Machine,
	type MachineName,
	type Phase,
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

function linkWord(machine: Machine): LinkWord | null {
	if (machine.life.phase !== "ready") return null;
	return machine.life.plug.kind === "none" ? "unplugged" : machine.life.plug.link;
}

export interface RailRow {
	readonly name: MachineName;
	readonly hue: HueNo;
	readonly phase: Phase;
	/** `10.88.0.12`, `10.88.0.12 · parked`, `did not boot`. */
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
			const line2 = life.phase === "failed" ? "did not boot" : machine.ip;
			return {
				name,
				hue: machine.hue,
				phase: life.phase,
				line2: isParked ? `${line2} · parked` : line2,
				word:
					life.phase === "booting"
						? bootingFor(life.since, now)
						: (linkWord(machine) ?? (life.phase === "ready" ? "unplugged" : life.phase)),
				focused: name === focused,
				parked: isParked,
			};
		}),
);

export interface DetailRow {
	readonly label: "state" | "image" | "memory" | "address" | "mac" | "uplink" | "link" | "shells";
	readonly value: string;
}

export interface MachineDetails {
	readonly name: MachineName;
	readonly hue: HueNo;
	readonly phase: Phase;
	/** The port its cable holds or has reserved. The element reads the port's frame counters with it. */
	readonly port: PortNo | null;
	/** The cable the cut and reconnect action works on. Null unless the machine is ready. */
	readonly link: LinkWord | null;
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

function linkValue(machine: Machine): string {
	const { life } = machine;
	const port = portOf(life);
	if (port === null) return "unplugged";
	if (life.phase === "booting") return "reserved";
	if (life.phase === "removing") return "down";
	return linkWord(machine) === "cut" ? "cable cut" : "connected";
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
			port: portOf(machine.life),
			link: linkWord(machine),
			reason: machine.life.phase === "failed" ? machine.life.reason : null,
			accepts: ACCEPTS[machine.life.phase],
			rows: [
				{ label: "state", value: stateValue(machine, now) },
				{ label: "image", value: image ? image.label : machine.spec.image },
				{ label: "memory", value: `${machine.spec.memMiB} MiB` },
				{ label: "address", value: `${machine.ip}/${LAB_PREFIX_BITS}` },
				{ label: "mac", value: machine.mac },
				{ label: "uplink", value: "lab only" },
				{ label: "link", value: linkValue(machine) },
				{ label: "shells", value: machine.sessions.map(sessionLabel).join(", ") },
			],
		};
	},
);

export interface PortView {
	readonly port: PortNo;
	/** In `removing` the link is already down and the port frees when the machine is gone. */
	readonly state: "empty" | "booting" | "up" | "cut" | "removing";
	readonly machine: { readonly name: MachineName; readonly hue: HueNo } | null;
	/** The word under the socket, one of `boot`, `up`, `cut`, `down`. An empty port shows only its number. */
	readonly word: string | null;
	/** What a click will do, for the button's accessible name. Null when a click does nothing. */
	readonly actionLabel: string | null;
}

function portView(port: PortNo, machine: Machine | undefined): PortView {
	if (!machine) return { port, state: "empty", machine: null, word: null, actionLabel: null };
	const { name, hue, life } = machine;
	const holder = { name, hue };
	if (life.phase === "removing") return { port, state: "removing", machine: holder, word: "down", actionLabel: null };
	if (linkWord(machine) === "up") {
		return {
			port,
			state: "up",
			machine: holder,
			word: "up",
			actionLabel: `Cut the cable from ${name} to port ${port}`,
		};
	}
	if (linkWord(machine) === "cut") {
		const actionLabel = `Reconnect the cable from ${name} to port ${port}`;
		return { port, state: "cut", machine: holder, word: "cut", actionLabel };
	}
	return { port, state: "booting", machine: holder, word: "boot", actionLabel: null };
}

/** The faceplate's eight ports, lowest first. */
export const selectPorts: (state: LabState) => readonly PortView[] = memo(
	(s) => [s.machines, s.rail],
	(machines, rail) => {
		const list = machineList({ machines, rail });
		return PORTS.map((port) =>
			portView(
				port,
				list.find((machine) => portOf(machine.life) === port),
			),
		);
	},
);

export interface LinkCount {
	readonly up: number;
	/** Cables plugged in, whether up, cut, or waiting for a boot. A machine being removed no longer counts. */
	readonly total: number;
	readonly cut: number;
}

/** The numbers in `2 of 3 links up`, for the faceplate header and the status line. */
export const selectLinks: (state: LabState) => LinkCount = memo(
	(s) => [s.machines, s.rail],
	(machines, rail) => {
		const cabled = machineList({ machines, rail }).filter(
			(machine) => machine.life.phase !== "removing" && portOf(machine.life) !== null,
		);
		return {
			up: cabled.filter((machine) => linkWord(machine) === "up").length,
			total: cabled.length,
			cut: cabled.filter((machine) => linkWord(machine) === "cut").length,
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
	readonly key: "machines" | "sessions" | "links" | "webmcp" | "engine";
	readonly text: string;
	/** `quiet` when all is well, `down` for a failed machine or a cut cable, `warn` while a call waits. */
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
			right: [webmcpSegment(agent, indicator), { key: "engine", text: "unkernel / WebAssembly", tone: "quiet" }],
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
