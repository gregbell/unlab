import {
	defaultAddress,
	defaultName,
	GATEWAY_SUBNETS,
	ip4str,
	MAX_NODE,
	type NameBook,
	NICS,
	type NicNo,
	type NodeNic,
	subnetsOverlap,
} from "../net/index.ts";
import { FIRST_SETS } from "./disks.ts";
import { identity, nicLabel, sessionLabel } from "./identity.ts";
import { without } from "./record.ts";
import { andThen, later, patch, step } from "./step.ts";
import {
	type Address,
	BOOT_TIMEOUT_MS,
	type BootPlan,
	type Cause,
	type Checkpoint,
	type CheckpointName,
	DEFAULT_SWITCH,
	type DeadCable,
	type DiskCopy,
	type DiskSets,
	type Effect,
	type HostEntry,
	HUES,
	type HueNo,
	type LabState,
	type Lifecycle,
	type LinkChange,
	MAX_MACHINES,
	type Machine,
	type MachineName,
	type MachineSpec,
	type Next,
	type NicPorts,
	type NicRef,
	type NicSpec,
	type Phase,
	type Place,
	type PlanError,
	type Plug,
	type PlugPlan,
	type PlugPlanError,
	PORTS,
	type PortNo,
	type PortRef,
	type RestorePlan,
	type Saving,
	type Session,
	type SessionId,
	SHUTDOWN_MS,
	type SpawnPlan,
	type SpawnRequest,
	type Step,
	type StopHow,
	type SwitchCable,
	type SwitchName,
} from "./types.ts";

/** What a machine in each phase takes. `commands` is everything that needs its guest. */
export interface Accepts {
	readonly commands: boolean;
	readonly boot: boolean;
	readonly cables: boolean;
	readonly remove: boolean;
	readonly restore: boolean;
}

export const ACCEPTS: Readonly<Record<Phase, Accepts>> = {
	booting: { commands: false, boot: false, cables: false, remove: true, restore: false },
	ready: { commands: true, boot: false, cables: true, remove: true, restore: true },
	stopping: { commands: false, boot: false, cables: false, remove: true, restore: false },
	off: { commands: false, boot: true, cables: true, remove: true, restore: true },
	restoring: { commands: false, boot: false, cables: false, remove: true, restore: false },
	failed: { commands: false, boot: true, cables: false, remove: true, restore: true },
	removing: { commands: false, boot: false, cables: false, remove: false, restore: false },
};

const FAILS: readonly Phase[] = ["booting", "ready", "stopping", "restoring"];
const BOOT_TIMEOUT_REASON = `No prompt after ${BOOT_TIMEOUT_MS / 1000} s.`;
/** What a stop that the guest did not finish leaves to say. */
export const FORCED_STOP = `It did not shut down in ${SHUTDOWN_MS / 1000} s, so it was stopped, and what it had not written to disk may be lost.`;
const UNPLUGGED: Plug = { kind: "none" };

/** The machines in rail order, which is spawn order. */
export function machineList(state: Pick<LabState, "machines" | "rail">): readonly Machine[] {
	return state.rail.flatMap((name) => state.machines[name] ?? []);
}

/** One for each NIC, eth0 first. None while it is failed or being removed. */
export function plugsOf(life: Lifecycle): readonly Plug[] {
	return life.phase === "failed" || life.phase === "removing" ? [] : life.plugs;
}

/** The port each NIC holds. Cut cables, and machines that are off or being removed, still hold theirs. A failed machine has none. */
export function nicPortsOf(life: Lifecycle): NicPorts {
	if (life.phase === "removing") return life.ports;
	return plugsOf(life).map((plug) => (plug.kind === "port" ? plug.port : null));
}

export function portsOf(life: Lifecycle): readonly PortRef[] {
	return nicPortsOf(life).flatMap((port) => port ?? []);
}

/** The checkpoint that is being saved. Its disks are not to stop or start under it. */
export function savingOf(life: Lifecycle): Saving | null {
	return life.phase === "ready" || life.phase === "off" ? (life.saving ?? null) : null;
}

export function samePort(a: PortRef, b: PortRef): boolean {
	return a.switch === b.switch && a.port === b.port;
}

export function takenPorts(state: LabState, on: SwitchName): ReadonlySet<PortNo> {
	return new Set(heldPorts(state, on).map(({ port }) => port));
}

/** What goes by the name now. A machine that is being removed still does. */
export function nameHolder(state: LabState, name: MachineName | SwitchName): "machine" | "switch" | null {
	if (state.switches.some((other) => other === name)) return "switch";
	return state.rail.some((other) => other === name) ? "machine" : null;
}

/** A port and the NIC whose cable is in it, or was when its machine began to go. */
export interface NicPort {
	readonly port: PortNo;
	readonly machine: Machine;
	readonly nic: NicNo;
}

/** A port and where the cable in it goes: another port of a switch. */
export interface CablePort {
	readonly port: PortNo;
	readonly far: PortRef;
	readonly link: SwitchCable["link"];
}

export type HeldPort = NicPort | CablePort;

export function holdsNic(held: HeldPort): held is NicPort {
	return "machine" in held;
}

/** What says which ports are taken. */
export type Wiring = Pick<LabState, "machines" | "rail" | "switchCables">;

/** The ports of the switch that are taken, lowest first. */
export function heldPorts(state: Wiring, on: SwitchName): readonly HeldPort[] {
	const nics = machineList(state).flatMap((machine) => {
		const ports = nicPortsOf(machine.life);
		return NICS.flatMap((nic): NicPort[] => {
			const ref = ports[nic];
			return ref?.switch === on ? [{ port: ref.port, machine, nic }] : [];
		});
	});
	const cables = state.switchCables.flatMap(({ ends: [a, b], link }): CablePort[] => [
		...(a.switch === on ? [{ port: a.port, far: b, link }] : []),
		...(b.switch === on ? [{ port: b.port, far: a, link }] : []),
	]);
	return [...nics, ...cables].sort((a, b) => a.port - b.port);
}

/** Those of them that NICs are in. */
export function nicPorts(state: Wiring, on: SwitchName): readonly NicPort[] {
	return heldPorts(state, on).filter(holdsNic);
}

/** Whose cable is in the port: a NIC's, or that from another port of a switch. */
export function holderOf(held: HeldPort): NicRef | PortRef {
	return holdsNic(held) ? { machine: held.machine.name, nic: held.nic } : held.far;
}

/** Up to `count` of the switch's free ports, lowest first. A switch that is not there has none. */
export function lowestFreePorts(state: LabState, on: SwitchName, count: number): readonly PortNo[] {
	if (!state.switches.includes(on)) return [];
	const taken = takenPorts(state, on);
	return PORTS.filter((port) => !taken.has(port)).slice(0, Math.max(0, count));
}

/** Up to `count` hues no machine has, in palette order. A machine holds its hue in every phase. */
export function firstFreeHues(state: LabState, count: number): readonly HueNo[] {
	const used = new Set(machineList(state).map((machine) => machine.hue));
	return HUES.filter((hue) => !used.has(hue)).slice(0, Math.max(0, count));
}

/** The address a machine goes by: the first one the lab set on it, or null when it set none. */
export function addressOf({ spec }: Pick<Machine, "spec">): Address | null {
	return addressed(spec)[0]?.address ?? null;
}

/** Every machine in the lab that has an address, for each guest's /etc/hosts. */
export function hostsFor(state: LabState): readonly HostEntry[] {
	return machineList(state).flatMap((machine) => {
		const address = addressOf(machine);
		return address ? [{ ip: ip4str(address.ip), name: machine.name }] : [];
	});
}

/** A machine's NICs that have an address, eth0 first. */
function addressed(spec: MachineSpec): readonly { readonly nic: NicNo; readonly address: Address }[] {
	return NICS.flatMap((nic) => {
		const address = spec.nics[nic]?.address;
		return address ? [{ nic, address }] : [];
	});
}

type Named = Pick<LabState, "machines" | "rail" | "departed" | "switches" | "departedSwitches">;

/** Who is who in the lab now. What is gone keeps its name until something else takes it. */
export function nameBook(state: Named): NameBook {
	const holders = new Map<MachineName, number>();
	for (const name of Object.keys(state.departed) as MachineName[]) {
		const gone = state.departed[name];
		if (gone) holders.set(name, gone.n);
	}
	const addresses = new Map<number, NodeNic>();
	for (const { n, name, spec } of machineList(state)) {
		holders.set(name, n);
		for (const { nic, address } of addressed(spec)) addresses.set(address.ip, { n, nic });
	}
	return {
		addresses,
		names: new Map([...holders].map(([name, n]) => [n, name])),
		switches: new Set([...state.switches, ...state.departedSwitches]),
	};
}

export function isPlanError(plan: object | null): plan is PlanError | PlugPlanError {
	return plan !== null && "kind" in plan;
}

/**
 * What a spawn of `count` machines will be. Numbers come from the counter,
 * names from the request or the numbers, hues are the first free ones, ports
 * the lowest free ones of each NIC's switch, in machine and NIC order. The reducer applies this plan
 * and no other.
 */
export function planSpawn(state: LabState, count: number, request: SpawnRequest): SpawnPlan | PlanError {
	if (!state.images.some((image) => image.name === request.image))
		return { kind: "unknown-image", image: request.image };
	const used = state.rail.length;
	const room = Math.max(0, Math.min(MAX_MACHINES - used, HUES.length - used, MAX_NODE + 1 - state.nextN));
	if (count > room) return { kind: "no-room", free: room, wanted: count };
	const names = Array.from({ length: count }, (_, i) => request.name ?? defaultName(state.nextN + i));
	for (const [i, name] of names.entries()) {
		const by = names.indexOf(name) < i ? "machine" : nameHolder(state, name);
		if (by) return { kind: "name-taken", name, by };
	}
	const nets = request.nics.map(({ net }) => net);
	const ports = claimPorts(
		state,
		names.flatMap(() => nets),
	);
	if (isPlanError(ports)) return ports;
	const machines = firstFreeHues(state, count).map((hue, i): SpawnPlan["machines"][number] => ({
		identity: identity(state.nextN + i, names[i]),
		hue,
		ports: ports.slice(i * nets.length, (i + 1) * nets.length),
		spec: specFor(request, state.nextN + i),
	}));
	const held = new Map<number, NicRef>();
	const hold = (machine: MachineName, spec: MachineSpec) => {
		for (const { nic, address } of addressed(spec)) held.set(address.ip, { machine, nic });
	};
	for (const { name, spec } of machineList(state)) hold(name, spec);
	for (const { identity: id, spec } of machines) {
		const clash = addressClash(spec, held);
		if (clash) return clash;
		hold(id.name, spec);
	}
	return { machines, request };
}

function specFor({ name: _, ...hardware }: SpawnRequest, n: number): MachineSpec {
	return {
		...hardware,
		nics: hardware.nics.map(({ net, address }) => ({
			net,
			address: address === "default" ? defaultAddress(n) : address,
		})),
	};
}

/** Why the machine cannot have the addresses it asks for, or null when it can. */
function addressClash(spec: MachineSpec, held: ReadonlyMap<number, NicRef>): PlanError | null {
	const own = addressed(spec);
	for (const [i, { nic, address }] of own.entries()) {
		const by = held.get(address.ip);
		if (by) return { kind: "address-taken", address, by };
		const subnet = spec.gateway ? GATEWAY_SUBNETS.find((kept) => subnetsOverlap(kept, address)) : undefined;
		if (subnet) return { kind: "address-gateway", address, subnet };
		const other = own.slice(i + 1).find((later) => subnetsOverlap(later.address, address));
		if (other) return { kind: "address-overlap", nics: [nic, other.nic] };
	}
	return null;
}

/** Each NIC's lowest free port on its switch, in order. Null for one on none. */
function claimPorts(state: LabState, nets: readonly NicSpec["net"][]): NicPorts | PlanError {
	const ports: (PortRef | null)[] = nets.map(() => null);
	for (const on of new Set(nets)) {
		if (on === "none") continue;
		const nics = nets.flatMap((net, nic) => (net === on ? [nic] : []));
		const free = lowestFreePorts(state, on, nics.length);
		if (free.length < nics.length) return { kind: "no-ports", switch: on, free: free.length, wanted: nics.length };
		for (const [i, nic] of nics.entries()) ports[nic] = { switch: on, port: free[i] };
	}
	return ports;
}

function plugInto(ports: NicPorts): readonly Plug[] {
	return ports.map((port) => (port === null ? UNPLUGGED : { kind: "port", port, link: "up" }));
}

/** Whether the machine's name alone does not say which NIC. False for a machine that is gone. */
export function severalNics(state: Pick<LabState, "machines">, name: MachineName): boolean {
	return (state.machines[name]?.spec.nics.length ?? 1) > 1;
}

/** Every NIC the machine was spawned with, eth0 first. */
export function nicsOf(state: Pick<LabState, "machines">, name: MachineName): readonly NicRef[] {
	const count = state.machines[name]?.spec.nics.length ?? 0;
	return NICS.slice(0, count).map((nic) => ({ machine: name, nic }));
}

/**
 * The cables that would change. A machine's name alone is all its NICs. NICs
 * of machines that take no cable now, are not there, or are already as asked are left out.
 * `link up` on an unplugged NIC takes the default switch's lowest free port.
 */
export function planLink(
	state: LabState,
	targets: readonly (MachineName | NicRef)[],
	up: boolean,
): readonly LinkChange[] | PlanError {
	const asked = new Map<string, NicRef>();
	for (const target of targets) {
		for (const ref of typeof target === "string" ? nicsOf(state, target) : [target]) {
			asked.set(`${ref.machine}:${ref.nic}`, ref);
		}
	}
	const plugs = [...asked.values()].flatMap(({ machine, nic }) => {
		const life = state.machines[machine]?.life;
		const plug = life && ACCEPTS[life.phase].cables ? plugsOf(life)[nic] : undefined;
		return plug ? [{ machine, nic, plug }] : [];
	});
	const ports = claimPorts(
		state,
		plugs.flatMap(({ plug }) => (up && plug.kind === "none" ? [DEFAULT_SWITCH] : [])),
	);
	if (isPlanError(ports)) return ports;
	let claimed = 0;
	return plugs.flatMap(({ machine, nic, plug }): LinkChange[] => {
		if (plug.kind === "none") {
			const port = up ? ports[claimed++] : null;
			return port ? [{ machine, nic, up, port, newPort: true }] : [];
		}
		return (plug.link === "up") === up ? [] : [{ machine, nic, up, port: plug.port, newPort: false }];
	});
}

/** Where the NIC's cable would go: the port that it is in, when that is in the place already. */
export function planPlug(
	state: LabState,
	{ machine, nic }: NicRef,
	{ switch: on, port }: Place,
): (PlugPlan & { readonly to: PortRef }) | PlugPlanError {
	const noPorts: PlugPlanError = { kind: "no-ports", switch: on, free: 0, wanted: 1 };
	if (!state.switches.includes(on)) return noPorts;
	const held = heldPorts(state, on);
	const own = held.find((other) => holdsNic(other) && other.machine.name === machine && other.nic === nic);
	const to = port ?? own?.port ?? lowestFreePorts(state, on, 1)[0];
	if (to === undefined) return noPorts;
	const by = held.find((other) => other.port === to);
	return by && by !== own
		? { kind: "port-taken", port: { switch: on, port: to }, by: holderOf(by) }
		: { machine, nic, to: { switch: on, port: to } };
}

/** Those of the machines that are off or failed. */
export function planBoot(state: LabState, names: readonly MachineName[]): readonly BootPlan[] | PlanError {
	const machines = [...new Set(names)]
		.flatMap((name) => state.machines[name] ?? [])
		.filter(({ life }) => savingOf(life) === null);
	const failed = machines.filter((machine) => machine.life.phase === "failed");
	const ports = claimPorts(
		state,
		failed.flatMap(({ spec }) => spec.nics.map(({ net }) => net)),
	);
	if (isPlanError(ports)) return ports;
	let claimed = 0;
	return machines.flatMap(({ name, life, spec }): BootPlan[] => {
		if (life.phase === "off") return [{ machine: name, ports: nicPortsOf(life) }];
		if (life.phase !== "failed") return [];
		const from = claimed;
		claimed += spec.nics.length;
		return [{ machine: name, ports: ports.slice(from, claimed) }];
	});
}

/** What going back to the checkpoint of that number would take, or null when the machine cannot now. */
export function planRestore(state: LabState, name: MachineName, set: number): RestorePlan | PlanError | null {
	const machine = state.machines[name];
	if (!machine?.sets.checkpoints.some((checkpoint) => checkpoint.set === set)) return null;
	const { life, spec } = machine;
	if (!ACCEPTS[life.phase].restore || savingOf(life)) return null;
	if (life.phase !== "failed") return { machine: name, set, ports: nicPortsOf(life) };
	const ports = claimPorts(
		state,
		spec.nics.map(({ net }) => net),
	);
	return isPlanError(ports) ? ports : { machine: name, set, ports };
}

/** Both are plain data that one planner laid out. */
function samePlan(a: SpawnPlan["machines"] | readonly BootPlan[] | RestorePlan, b: typeof a): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/** `node1`, `node1 and node2`, `node1, node2 and node3`. */
export function andList(words: readonly (string | number)[]): string {
	if (words.length < 2) return words.join("");
	return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

function put(state: LabState, machine: Machine): LabState {
	return { ...state, machines: { ...state.machines, [machine.name]: machine } };
}

/** The machine, if this event is about its current boot attempt. */
function onAttempt(state: LabState, name: MachineName, attempt: number): Machine | null {
	const machine = state.machines[name];
	return machine && machine.life.attempt === attempt ? machine : null;
}

/** The machine's plugged NICs, eth0 first, each with the port its cable is in. */
function cablesOf(life: Lifecycle): readonly { nic: NicNo; port: PortRef; link: "up" | "cut" }[] {
	const plugs = plugsOf(life);
	return NICS.flatMap((nic) => {
		const plug = plugs[nic];
		return plug?.kind === "port" ? [{ nic, port: plug.port, link: plug.link }] : [];
	});
}

/** What its machine is doing, when that keeps the links of its cables down. They come up at the first prompt, and stay until the guest has stopped. */
function unlinkedBy(life: Lifecycle): DeadCable["machine"] {
	switch (life.phase) {
		case "booting":
		case "off":
		case "restoring":
			return life.phase;
		case "stopping":
			return life.linked ? null : life.phase;
		default:
			return null;
	}
}

/** Takes down every link that is up on the switch. */
function linksDown({ name, life }: Machine, cause: Cause): Effect[] {
	if (unlinkedBy(life) !== null) return [];
	return cablesOf(life)
		.filter(({ link }) => link === "up")
		.map(({ port, nic }) => ({ type: "link/set", port, machine: name, nic, up: false, cause }));
}

/** A cable is put in the port or taken out of it, with the link it has. */
function replug(
	{ name, life }: Machine,
	{ nic, port, link }: ReturnType<typeof cablesOf>[number],
	way: "in" | "out",
	cause: Cause,
): Effect {
	const by = unlinkedBy(life);
	const cut = link === "cut";
	return cut || by !== null
		? { type: "capture/dead-cable", port, machine: name, nic, cause, dead: { way, cut, machine: by } }
		: { type: "link/set", port, machine: name, nic, up: way === "in", cause, plug: true };
}

const onSwitch = (on: SwitchName) => (port: PortRef | null) => port?.switch === on;

function unplugged(life: Lifecycle, on: SwitchName): Lifecycle {
	const gone = onSwitch(on);
	if (life.phase === "failed") return life;
	if (life.phase === "removing") return { ...life, ports: life.ports.map((port) => (gone(port) ? null : port)) };
	return { ...life, plugs: life.plugs.map((plug) => (plug.kind === "port" && gone(plug.port) ? UNPLUGGED : plug)) };
}

/** Every NIC off the switch, and none to be plugged into it at a later boot. What the machines run goes on. */
export function unplugAll(state: LabState, on: SwitchName, cause: Cause): Step {
	const effects: Effect[] = [];
	const machines = { ...state.machines };
	for (const machine of machineList(state)) {
		const { name, life, spec } = machine;
		const held = portsOf(life).filter(onSwitch(on));
		const asked = spec.nics.some(({ net }) => net === on);
		if (held.length === 0 && !asked) continue;
		effects.push(
			...cablesOf(life)
				.filter(({ port }) => port.switch === on)
				.map((cable) => replug(machine, cable, "out", cause)),
		);
		for (const port of held) effects.push({ type: "port/detach", port });
		const nics = spec.nics.map((nic): NicSpec => (nic.net === on ? { ...nic, net: "none" } : nic));
		machines[name] = { ...machine, life: unplugged(life, on), spec: { ...spec, nics } };
	}
	return step({ ...state, machines }, effects);
}

/** The ports go on the switch before the kernel boots, so its first frame has somewhere to go. */
function attachEffects({ name, life }: Machine): Effect[] {
	return cablesOf(life).map(({ port, nic }) => ({ type: "port/attach", port, machine: name, nic }));
}

function bootEffect({ n, name, mac, spec, life, sets }: Machine, state: LabState): Effect {
	return {
		type: "vm/boot",
		machine: name,
		attempt: life.attempt,
		config: { identity: { n, name, mac }, spec, set: sets.live, hosts: hostsFor(state) },
	};
}

function diskCopy({ n, name, spec, life }: Machine, checkpoint: CheckpointName, from: number, to: number): DiskCopy {
	return { machine: name, attempt: life.attempt, n, extras: spec.disks.extra.length, checkpoint, from, to };
}

/** The machine on its way back to a checkpoint. A new attempt, so nothing its last guest says is about this. */
function restoring(
	machine: Machine,
	from: Checkpoint,
	attempt: number,
	plugs: readonly Plug[],
	closed: readonly SessionId[],
): Machine {
	const set = machine.sets.next;
	return {
		...machine,
		sets: { ...machine.sets, next: set + 1 },
		unsaved: null,
		life: { phase: "restoring", attempt, from, set, percent: 0, plugs, closed },
	};
}

function restoreEffects(machine: Machine): Effect[] {
	if (machine.life.phase !== "restoring") return [];
	const { from, set } = machine.life;
	return [{ type: "checkpoint/restore", copy: diskCopy(machine, from.name, from.set, set) }];
}

/**
 * Adds every row at once, all booting, each with its console open. A plan
 * that is no longer what `planSpawn` would say (a stale or repeated event) is
 * ignored, so allocation has one owner.
 */
export function spawn(state: LabState, plan: SpawnPlan, at: number): Step {
	const fresh = planSpawn(state, plan.machines.length, plan.request);
	if (isPlanError(fresh) || fresh.machines.length === 0 || !samePlan(fresh.machines, plan.machines)) return step(state);

	const nodes = fresh.machines.map(({ ports, ...machine }) => ({ ...machine, plugs: plugInto(ports) }));
	return bootMachines(state, nodes, state.nextN + nodes.length, at);
}

export interface BootNode {
	failure?: string;
	/** It is there, but it does not boot. */
	off?: boolean;
	sets?: DiskSets;
	/** A checkpoint it was going back to. */
	restore?: Checkpoint;
	identity: ReturnType<typeof identity>;
	hue: HueNo;
	spec: MachineSpec;
	plugs: readonly Plug[];
}

export function bootMachines(state: LabState, nodes: readonly BootNode[], nextN: number, at: number): Step {
	const machines = { ...state.machines };
	const sessions = { ...state.sessions };
	const added: Machine[] = [];
	for (const { identity: id, hue, spec, plugs, failure, off, restore, sets = FIRST_SETS } of nodes) {
		const tab: SessionId = `${id.name}:console`;
		const attempt = (state.departed[id.name]?.attempt ?? 0) + 1;
		const spawned: Machine = {
			...id,
			life:
				failure !== undefined
					? { phase: "failed", attempt, reason: failure }
					: off
						? { phase: "off", attempt, plugs }
						: { phase: "booting", attempt, since: at, stage: "", plugs },
			hue,
			spec,
			sessions: [tab],
			activeSession: tab,
			nextShell: 1,
			lastStop: null,
			sets,
			unsaved: null,
		};
		const machine = restore ? restoring(spawned, restore, attempt, plugs, []) : spawned;
		machines[id.name] = machine;
		sessions[tab] = { id: tab, machine: id.name, kind: "console", state: "open", shell: "unknown", agentLines: false };
		added.push(machine);
	}
	const next: LabState = {
		...state,
		now: later(state.now, at),
		nextN,
		machines,
		sessions,
		departedSwitches: state.departedSwitches.filter((name) => !(name in machines)),
		rail: [...state.rail, ...added.map((machine) => machine.name)],
	};
	const effects = added.flatMap((machine): Effect[] => [
		{ type: "screen/create", session: machine.activeSession },
		...attachEffects(machine),
		...(machine.life.phase === "booting" ? [bootEffect(machine, next)] : []),
		...restoreEffects(machine),
	]);
	return step(next, effects);
}

export function stage(state: LabState, name: MachineName, attempt: number, text: string): Step {
	const machine = onAttempt(state, name, attempt);
	if (machine?.life.phase !== "booting" || machine.life.stage === text) return step(state);
	return step(put(state, { ...machine, life: { ...machine.life, stage: text } }));
}

/** The first prompt. The links come up now, not at spawn, so a port's light means its NIC is up. */
export function ready(state: LabState, name: MachineName, attempt: number, bootMs: number): Step {
	const machine = onAttempt(state, name, attempt);
	if (machine?.life.phase !== "booting") return step(state);
	const { plugs } = machine.life;
	const next = put(state, { ...machine, life: { phase: "ready", attempt, bootMs, plugs } });
	const effects: Effect[] = [{ type: "announce", text: `${name} ready` }];
	const cause = machine.lastStop === null ? "runtime" : "power";
	for (const { nic, port, link } of cablesOf(machine.life)) {
		if (link === "up") effects.push({ type: "link/set", port, machine: name, nic, up: true, cause });
	}
	effects.push({ type: "hosts/publish", hosts: hostsFor(next) });
	return step(next, effects);
}

/** The machine with its console alone, and nothing known of what it runs. The shells end with the guest. */
function shellsClosed(state: LabState, machine: Machine): { state: LabState; machine: Machine; effects: Effect[] } {
	const [tab, ...shells] = machine.sessions;
	let sessions = state.sessions;
	for (const session of shells) sessions = without(sessions, session);
	const consoleSession = sessions[tab];
	if (consoleSession) sessions = { ...sessions, [tab]: patch(consoleSession, { shell: "unknown" }) };
	return {
		state: { ...state, sessions },
		machine: { ...machine, sessions: [tab], activeSession: tab },
		effects: shells.map((session) => ({ type: "screen/dispose", session })),
	};
}

/**
 * A boot that errs or times out, a guest that dies, or a checkpoint that cannot
 * be gone back to. The cables are withdrawn and the ports freed. The console
 * stays for scrolling back.
 */
export function fail(state: LabState, name: MachineName, attempt: number, reason: string): Step {
	const machine = onAttempt(state, name, attempt);
	if (!machine) return step(state);
	const { life } = machine;
	if (!FAILS.includes(life.phase)) return step(state);

	const alone = shellsClosed(state, machine);
	const effects: Effect[] = [
		...linksDown(machine, "runtime"),
		{ type: "vm/stop", machine: name, attempt, how: "save" },
	];
	for (const port of portsOf(life)) effects.push({ type: "port/detach", port });
	effects.push(...alone.effects);
	effects.push({ type: "announce", text: [`${name} failed.`, reason].filter(Boolean).join(" ") });
	const failed: Machine = { ...alone.machine, life: { phase: "failed", attempt, reason }, lastStop: null };
	return step(put(alone.state, failed), effects);
}

/** `sh1 and sh2 closed with it.` */
function closedWithIt(closed: readonly SessionId[]): string[] {
	return closed.length === 0 ? [] : [`${andList(closed.map(sessionLabel))} closed with it.`];
}

/** The machine keeps its plugs, and its links until its worker is gone. */
function stopping(state: LabState, machine: Machine, next: Next, how: StopHow, ended: readonly SessionId[] = []): Step {
	const { name, life } = machine;
	const alone = shellsClosed(state, machine);
	const [, ...shells] = machine.sessions;
	const closed = [...new Set([...ended, ...shells])];
	const doing = next === "off" ? `${name} powering off` : `${name} rebooting`;
	const said = closed.length === 0 ? doing : [`${doing}.`, ...closedWithIt(closed)].join(" ");
	return step(
		put(alone.state, {
			...alone.machine,
			life: {
				phase: "stopping",
				attempt: life.attempt,
				next,
				plugs: plugsOf(life),
				linked: life.phase === "ready",
				closed,
			},
		}),
		[
			{ type: "vm/stop", machine: name, attempt: life.attempt, how },
			...alone.effects,
			{ type: "announce", text: said },
		],
	);
}

/** The guest of each ready machine is asked to shut down. */
export function power(state: LabState, names: readonly MachineName[], next: Next): Step {
	let result = step(state);
	for (const name of new Set(names)) {
		result = andThen(result, (s) => {
			const machine = s.machines[name];
			const takes = machine && ACCEPTS[machine.life.phase].commands && !savingOf(machine.life);
			return takes ? stopping(s, machine, next, next) : step(s);
		});
	}
	return result;
}

/** The guest shut down by itself, and the disks have still to be saved. A machine that was told what comes next does that. */
export function halted(
	state: LabState,
	name: MachineName,
	attempt: number,
	next: Next,
	closed: readonly SessionId[],
): Step {
	const machine = onAttempt(state, name, attempt);
	if (machine?.life.phase !== "booting" && machine?.life.phase !== "ready") return step(state);
	return stopping(state, machine, next, "save", closed);
}

/** The worker is gone and has let go of its disks, so the machine can go on to what it was stopped for. */
export function stopped(state: LabState, name: MachineName, attempt: number, clean: boolean, at: number): Step {
	const machine = onAttempt(state, name, attempt);
	if (machine?.life.phase === "removing") return gone(state, machine);
	if (machine?.life.phase !== "stopping") return step(state);
	const { next, plugs, closed } = machine.life;
	const forced = clean ? [] : [FORCED_STOP];
	const now = next === "off" ? `${name} is off.` : `${name} is rebooting.`;
	const note = [now, ...closedWithIt(closed), ...forced].join(" ");
	const effects: Effect[] = [
		...linksDown(machine, "power"),
		{ type: "screen/note", session: machine.sessions[0], text: note },
	];
	const lastStop = clean ? "clean" : "forced";
	if (next === "reboot") {
		const booting = boot({ ...machine, lastStop }, plugs, at);
		const after = put({ ...state, now: later(state.now, at) }, booting);
		if (!clean) effects.push({ type: "announce", text: `${name} rebooting. ${FORCED_STOP}` });
		return step(after, [...effects, bootEffect(booting, after)]);
	}
	effects.push({ type: "announce", text: clean ? `${name} off` : `${name} off. ${FORCED_STOP}` });
	return step(put(state, { ...machine, life: { phase: "off", attempt, plugs }, lastStop }), effects);
}

/** A NIC that is gone from a guest that still runs. */
export function nicLost(state: LabState, name: MachineName, attempt: number, nic: NicNo, reason: string): Step {
	const machine = onAttempt(state, name, attempt);
	if (machine?.life.phase !== "ready" || machine.life.lost?.includes(nic)) return step(state);
	const lost = [...(machine.life.lost ?? []), nic];
	return step(put(state, { ...machine, life: { ...machine.life, lost } }), [
		{ type: "announce", text: `${name} lost a NIC. ${reason} Reboot it to have it back.` },
	]);
}

/** A boot is late when the clock says so. No timer exists that could fire on a later attempt. */
export function expireBoots(state: LabState): Step {
	let result = step(state);
	for (const { name, life } of machineList(state)) {
		if (life.phase !== "booting" || state.now - life.since < BOOT_TIMEOUT_MS) continue;
		const { attempt } = life;
		result = andThen(result, (s) => fail(s, name, attempt, BOOT_TIMEOUT_REASON));
	}
	return result;
}

export function remove(state: LabState, names: readonly MachineName[], cause: Cause): Step {
	let result = step(state);
	for (const name of new Set(names)) result = andThen(result, (s) => removeOne(s, name, cause));
	return result;
}

/** The links drop first, so neighbours see the machine leave. The ports are held until it is gone. */
function removeOne(state: LabState, name: MachineName, cause: Cause): Step {
	const machine = state.machines[name];
	if (!machine || !ACCEPTS[machine.life.phase].remove) return step(state);
	const { life } = machine;
	const removing: Machine = { ...machine, life: { phase: "removing", attempt: life.attempt, ports: nicPortsOf(life) } };
	return step(put(state, removing), [
		...linksDown(machine, cause),
		{ type: "vm/stop", machine: name, attempt: life.attempt, how: "drop" },
	]);
}

/** The record goes, and its hue and ports are free again. */
function gone(state: LabState, machine: Machine): Step {
	const { name } = machine;
	const { attempt } = machine.life;
	let sessions = state.sessions;
	for (const session of machine.sessions) sessions = without(sessions, session);
	const next: LabState = {
		...state,
		machines: without(state.machines, name),
		departed: { ...state.departed, [name]: { n: machine.n, attempt } },
		rail: state.rail.filter((other) => other !== name),
		sessions,
	};
	const effects = portsOf(machine.life).map((port): Effect => ({ type: "port/detach", port }));
	for (const session of machine.sessions) effects.push({ type: "screen/dispose", session });
	effects.push(
		{ type: "disks/delete", n: machine.n, sets: Array.from({ length: machine.sets.next }, (_, set) => set) },
		{ type: "hosts/publish", hosts: hostsFor(next) },
		{ type: "announce", text: `${name} removed` },
	);
	return step(next, effects);
}

/** Its next attempt: same name, hue, image, memory and disks. */
function boot(machine: Machine, plugs: readonly Plug[], at: number): Machine {
	const attempt = machine.life.attempt + 1;
	return { ...machine, life: { phase: "booting", attempt, since: at, stage: "", plugs } };
}

/** Machines that are off or failed, on the planned ports. Ignored unless that is still the plan. */
export function bootStopped(state: LabState, plan: readonly BootPlan[], at: number): Step {
	const fresh = planBoot(
		state,
		plan.map(({ machine }) => machine),
	);
	if (isPlanError(fresh) || !samePlan(fresh, plan)) return step(state);
	let result = step(state);
	for (const { machine: name, ports } of fresh) {
		result = andThen(result, (s) => {
			const machine = s.machines[name];
			if (!machine) return step(s);
			// An off machine is plugged in already.
			const held = machine.life.phase === "off" ? machine.life.plugs : null;
			const booting = boot(machine, held ?? plugInto(ports), at);
			const next = put({ ...s, now: later(s.now, at) }, booting);
			return step(next, [...(held ? [] : attachEffects(booting)), bootEffect(booting, next)]);
		});
	}
	return result;
}

/** A person's name for the machine's disks as they are now. Ignored unless it is free. */
export function saveCheckpoint(state: LabState, name: MachineName, checkpoint: CheckpointName): Step {
	const machine = state.machines[name];
	if (machine?.life.phase !== "ready" && machine?.life.phase !== "off") return step(state);
	const { life, sets } = machine;
	if (life.saving || sets.checkpoints.some((other) => other.name === checkpoint)) return step(state);
	const set = sets.next;
	const saving: Machine = {
		...machine,
		sets: { ...sets, next: set + 1 },
		unsaved: null,
		life: { ...life, saving: { name: checkpoint, set, percent: 0 } },
	};
	return step(put(state, saving), [
		{ type: "checkpoint/save", copy: diskCopy(machine, checkpoint, sets.live, set) },
		{ type: "announce", text: `saving checkpoint ${checkpoint} of ${name}` },
	]);
}

/** How much of the set that a machine is writing has been written. */
export function checkpointProgress(
	state: LabState,
	name: MachineName,
	attempt: number,
	set: number,
	percent: number,
): Step {
	const machine = onAttempt(state, name, attempt);
	if (!machine) return step(state);
	const { life } = machine;
	if (life.phase === "restoring" && life.set === set)
		return step(put(state, { ...machine, life: patch(life, { percent }) }));
	const saving = savingOf(life);
	if ((life.phase !== "ready" && life.phase !== "off") || saving?.set !== set) return step(state);
	return step(put(state, { ...machine, life: { ...life, saving: patch(saving, { percent }) } }));
}

/** The machine, no longer saving the set, or null when it was not. */
function savingOver(state: LabState, name: MachineName, attempt: number, set: number): [Machine, Saving] | null {
	const machine = onAttempt(state, name, attempt);
	if (machine?.life.phase !== "ready" && machine?.life.phase !== "off") return null;
	const { saving, ...life } = machine.life;
	return saving?.set === set ? [{ ...machine, life }, saving] : null;
}

export function checkpointSaved(state: LabState, name: MachineName, attempt: number, set: number, bytes: number): Step {
	const over = savingOver(state, name, attempt, set);
	if (!over) return step(state);
	const [machine, saving] = over;
	const checkpoints = [...machine.sets.checkpoints, { name: saving.name, set, bytes }];
	return step(put(state, { ...machine, sets: { ...machine.sets, checkpoints } }), [
		{ type: "announce", text: `checkpoint ${saving.name} of ${name} saved` },
	]);
}

export function checkpointUnsaved(
	state: LabState,
	name: MachineName,
	attempt: number,
	set: number,
	reason: string,
): Step {
	const over = savingOver(state, name, attempt, set);
	if (!over) return step(state);
	return step(put(state, { ...over[0], unsaved: { set, reason } }), [{ type: "announce", text: reason }]);
}

/** The guest is dropped, as its disks are, and the machine keeps its cables in. Ignored unless that is still the plan. */
export function restore(state: LabState, plan: RestorePlan): Step {
	const fresh = planRestore(state, plan.machine, plan.set);
	if (fresh === null || isPlanError(fresh) || !samePlan(fresh, plan)) return step(state);
	const machine = state.machines[fresh.machine];
	const from = machine?.sets.checkpoints.find(({ set }) => set === fresh.set);
	if (!machine || !from) return step(state);
	const { name, life } = machine;
	const alone = shellsClosed(state, machine);
	const [, ...closed] = machine.sessions;
	const held = life.phase === "failed" ? null : plugsOf(life);
	const back = restoring(alone.machine, from, life.attempt + 1, held ?? plugInto(fresh.ports), closed);
	const doing = `${name} going back to checkpoint ${from.name}`;
	const said = closed.length === 0 ? doing : [`${doing}.`, ...closedWithIt(closed)].join(" ");
	return step(put(alone.state, { ...back, lastStop: held ? "clean" : null }), [
		...linksDown(machine, "power"),
		{ type: "vm/stop", machine: name, attempt: back.life.attempt, how: "drop" },
		...(held ? [] : attachEffects(back)),
		...alone.effects,
		{ type: "announce", text: said },
		...restoreEffects(back),
	]);
}

/** The copy is whole, so it is what the machine has from here on. */
export function restored(state: LabState, name: MachineName, attempt: number, set: number, at: number): Step {
	const machine = onAttempt(state, name, attempt);
	if (machine?.life.phase !== "restoring" || machine.life.set !== set) return step(state);
	const { plugs, from, closed } = machine.life;
	const replaced = machine.sets.live;
	const booting = boot({ ...machine, sets: { ...machine.sets, live: set } }, plugs, at);
	const after = put({ ...state, now: later(state.now, at) }, booting);
	const note = [`${name} is back at checkpoint ${from.name}.`, ...closedWithIt(closed)].join(" ");
	return step(after, [
		{ type: "screen/note", session: machine.sessions[0], text: note },
		{ type: "disks/delete", n: machine.n, sets: [replaced] },
		bootEffect(booting, after),
	]);
}

/** A checkpoint that the machine is going back to stays until it has. */
export function forget(state: LabState, name: MachineName, set: number): Step {
	const machine = state.machines[name];
	if (!machine || machine.life.phase === "removing") return step(state);
	if (machine.life.phase === "restoring" && machine.life.from.set === set) return step(state);
	const checkpoints = machine.sets.checkpoints.filter((checkpoint) => checkpoint.set !== set);
	if (checkpoints.length === machine.sets.checkpoints.length) return step(state);
	return step(put(state, { ...machine, sets: { ...machine.sets, checkpoints } }), [
		{ type: "disks/delete", n: machine.n, sets: [set] },
		{ type: "announce", text: `checkpoint of ${name} deleted` },
	]);
}

export function link(state: LabState, changes: readonly LinkChange[], cause: Cause): Step {
	let result = step(state);
	for (const change of changes) result = andThen(result, (s) => linkOne(s, change, cause));
	return result;
}

/** The machine with one NIC's cable as given, now and for its later boots. Null for a NIC that takes no change. */
function rewired(machine: Machine, nic: NicNo, plug: Plug): Machine | null {
	const { life, spec } = machine;
	if ((life.phase !== "ready" && life.phase !== "off") || !life.plugs[nic]) return null;
	const net = plug.kind === "port" ? plug.port.switch : "none";
	const at = <T>(list: readonly T[], change: (old: T) => T) => list.map((old, i) => (i === nic ? change(old) : old));
	return {
		...machine,
		life: { ...life, plugs: at(life.plugs, () => plug) },
		spec: { ...spec, nics: at(spec.nics, (old) => ({ ...old, net })) },
	};
}

function linkOne(state: LabState, change: LinkChange, cause: Cause): Step {
	const machine = state.machines[change.machine];
	if (machine?.life.phase !== "ready" && machine?.life.phase !== "off") return step(state);
	const { port, nic, up } = change;
	const plug = machine.life.plugs[nic];
	if (!plug) return step(state);
	const fits = change.newPort
		? up && plug.kind === "none" && lowestFreePorts(state, port.switch, 1)[0] === port.port
		: plug.kind === "port" && samePort(plug.port, port) && (plug.link === "up") !== up;
	if (!fits) return step(state);

	const changed = rewired(machine, nic, { kind: "port", port, link: up ? "up" : "cut" });
	if (!changed) return step(state);
	const next = put(state, changed);
	const label = nicLabel(machine, nic);
	const effects: Effect[] = [];
	if (change.newPort) effects.push({ type: "port/attach", port, machine: machine.name, nic });
	// Its link is down, and what is plugged in now says whether it comes up at the next boot.
	if (machine.life.phase === "off") {
		return step(next, [...effects, { type: "announce", text: `${label} cable ${up ? "plugged in" : "cut"}` }]);
	}
	effects.push(
		{ type: "link/set", port, machine: machine.name, nic, up, cause },
		{ type: "announce", text: `${label} link ${up ? "up" : "down"}` },
	);
	return step(next, effects);
}

/**
 * Puts one NIC's cable where the plan says, or takes it out. What runs goes on.
 * A cable that moves is as it was, cut or not, and a new one is whole. Ignored
 * unless that is still the plan, or when the cable is there already.
 */
export function plug(state: LabState, plan: PlugPlan, cause: Cause): Step {
	const { machine: name, nic, to } = plan;
	const machine = state.machines[name];
	const old = machine && plugsOf(machine.life)[nic];
	if (!machine || !old || (to !== null && isPlanError(planPlug(state, plan, to)))) return step(state);
	const from = old.kind === "port" ? old.port : null;
	if (to === null ? from === null : from !== null && samePort(from, to)) return step(state);
	const set: Plug = to === null ? UNPLUGGED : { kind: "port", port: to, link: old.kind === "port" ? old.link : "up" };
	const changed = rewired(machine, nic, set);
	if (!changed) return step(state);

	const effects: Effect[] = [];
	// The link first, so the switch forgets what it had learned there and the capture says so.
	if (old.kind === "port") {
		effects.push(replug(machine, { ...old, nic }, "out", cause), { type: "port/detach", port: old.port });
	}
	if (set.kind === "port") {
		const { port } = set;
		effects.push({ type: "port/attach", port, machine: name, nic }, replug(machine, { ...set, nic }, "in", cause));
	}
	const label = nicLabel(machine, nic);
	const said = to === null ? "unplugged" : `plugged into ${to.switch} port ${to.port}`;
	return step(put(state, changed), [...effects, { type: "announce", text: `${label} ${said}` }]);
}

/** `sh<k>` on a ready machine. The number is per machine and never reused. */
export function openShell(state: LabState, name: MachineName): Step {
	const machine = state.machines[name];
	if (!machine || !ACCEPTS[machine.life.phase].commands) return step(state);
	const id: SessionId = `${name}:sh${machine.nextShell}`;
	const session: Session = { id, machine: name, kind: "shell", state: "opening", shell: "unknown", agentLines: false };
	const next = put(
		{ ...state, sessions: { ...state.sessions, [id]: session } },
		{ ...machine, sessions: [...machine.sessions, id], activeSession: id, nextShell: machine.nextShell + 1 },
	);
	// The screen first, so the pty's first bytes have somewhere to land.
	return step(next, [
		{ type: "screen/create", session: id },
		{ type: "pty/open", session: id },
	]);
}

function patchSession(state: LabState, id: SessionId, fields: Partial<Session>): Step {
	const session = state.sessions[id];
	if (!session) return step(state);
	const next = patch(session, fields);
	return next === session ? step(state) : step({ ...state, sessions: { ...state.sessions, [id]: next } });
}

export function sessionOpened(state: LabState, id: SessionId): Step {
	return patchSession(state, id, { state: "open" });
}

export function sessionShell(state: LabState, id: SessionId, shell: "prompt" | "running"): Step {
	return patchSession(state, id, { shell });
}

/** Only the agent's lines are remembered, because they drive the pane's blue-rule legend. */
export function sessionMarked(state: LabState, id: SessionId, source: "bar" | "agent"): Step {
	return source === "agent" ? patchSession(state, id, { agentLines: true }) : step(state);
}

/** A shell's process exited. Its tab closes, and the tab to its left takes over if it was active. */
export function sessionEnded(state: LabState, id: SessionId): Step {
	const session = state.sessions[id];
	if (session?.kind !== "shell") return step(state);
	const sessions = without(state.sessions, id);
	const effects: Effect[] = [{ type: "screen/dispose", session: id }];
	const machine = state.machines[session.machine];
	if (!machine) return step({ ...state, sessions }, effects);
	const at = machine.sessions.indexOf(id);
	const closed: Machine = {
		...machine,
		sessions: machine.sessions.filter((other) => other !== id),
		activeSession: machine.activeSession === id ? machine.sessions[Math.max(0, at - 1)] : machine.activeSession,
	};
	return step(put({ ...state, sessions }, closed), effects);
}

export function selectTab(state: LabState, id: SessionId): Step {
	const session = state.sessions[id];
	const machine = session && state.machines[session.machine];
	if (!machine || machine.activeSession === id) return step(state);
	return step(put(state, { ...machine, activeSession: id }));
}
