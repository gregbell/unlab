import { MAX_NODE, NICS, type NicNo } from "../net/index.ts";
import { identity, nicLabel } from "./identity.ts";
import { without } from "./record.ts";
import { andThen, later, patch, step } from "./step.ts";
import {
	BOOT_TIMEOUT_MS,
	type Cause,
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
	type NicPorts,
	type NicRef,
	type NicSpec,
	type Phase,
	type PlanError,
	type Plug,
	PORTS,
	type PortNo,
	type Session,
	type SessionId,
	type SpawnPlan,
	type Step,
} from "./types.ts";

/** The last column of the handoff's lifecycle table. `commands` is everything but boot again and rm. */
export interface Accepts {
	readonly commands: boolean;
	readonly bootAgain: boolean;
	readonly remove: boolean;
}

export const ACCEPTS: Readonly<Record<Phase, Accepts>> = {
	booting: { commands: false, bootAgain: false, remove: true },
	ready: { commands: true, bootAgain: false, remove: true },
	failed: { commands: false, bootAgain: true, remove: true },
	removing: { commands: false, bootAgain: false, remove: false },
};

const BOOT_TIMEOUT_REASON = `No prompt after ${BOOT_TIMEOUT_MS / 1000} s.`;
const UNPLUGGED: Plug = { kind: "none" };

/** The machines in rail order, which is spawn order. */
export function machineList(state: Pick<LabState, "machines" | "rail">): readonly Machine[] {
	return state.rail.flatMap((name) => state.machines[name] ?? []);
}

/** One for each NIC, eth0 first. None while it is failed or being removed. */
export function plugsOf(life: Lifecycle): readonly Plug[] {
	return life.phase === "booting" || life.phase === "ready" ? life.plugs : [];
}

/** The port each NIC holds. Cut cables and removing machines still hold theirs. A failed machine has none. */
export function nicPortsOf(life: Lifecycle): NicPorts {
	if (life.phase === "removing") return life.ports;
	return plugsOf(life).map((plug) => (plug.kind === "port" ? plug.port : null));
}

export function portsOf(life: Lifecycle): readonly PortNo[] {
	return nicPortsOf(life).flatMap((port) => port ?? []);
}

export function takenPorts(state: LabState): ReadonlySet<PortNo> {
	return new Set(machineList(state).flatMap((machine) => portsOf(machine.life)));
}

/** Up to `count` free ports, lowest first. */
export function lowestFreePorts(state: LabState, count: number): readonly PortNo[] {
	const taken = takenPorts(state);
	return PORTS.filter((port) => !taken.has(port)).slice(0, Math.max(0, count));
}

/** Up to `count` hues no machine has, in palette order. A machine holds its hue in every phase. */
export function firstFreeHues(state: LabState, count: number): readonly HueNo[] {
	const used = new Set(machineList(state).map((machine) => machine.hue));
	return HUES.filter((hue) => !used.has(hue)).slice(0, Math.max(0, count));
}

/** Every machine in the lab, for each guest's /etc/hosts. */
export function hostsFor(state: LabState): readonly HostEntry[] {
	return machineList(state).map(({ ip, name }) => ({ ip, name }));
}

export function isPlanError(plan: object | null): plan is PlanError {
	return plan !== null && "kind" in plan;
}

/**
 * What a spawn of `count` machines will be. Names come from the counter, hues
 * are the first free ones, ports the lowest free ones in machine and NIC
 * order. The reducer applies this plan and no other.
 */
export function planSpawn(state: LabState, count: number, spec: MachineSpec): SpawnPlan | PlanError {
	if (!state.images.some((image) => image.name === spec.image)) return { kind: "unknown-image", image: spec.image };
	const held = state.rail.length;
	const room = Math.max(0, Math.min(MAX_MACHINES - held, HUES.length - held, MAX_NODE + 1 - state.nextN));
	if (count > room) return { kind: "no-room", free: room, wanted: count };
	const ports = claimPorts(state, count * pluggedNics(spec.nics));
	if (isPlanError(ports)) return ports;
	const hues = firstFreeHues(state, count);
	return {
		machines: hues.map((hue, i) => ({
			identity: identity(state.nextN + i),
			hue,
			ports: nicPorts(spec.nics, ports.slice(i * pluggedNics(spec.nics))),
		})),
		spec,
	};
}

function pluggedNics(nics: readonly NicSpec[]): number {
	return nics.filter((nic) => nic.net === "switch0").length;
}

/** The claimed ports, in order, to the NICs that plug in. */
function nicPorts(nics: readonly NicSpec[], ports: readonly PortNo[]): NicPorts {
	let next = 0;
	return nics.map((nic) => (nic.net === "switch0" ? ports[next++] : null));
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
 * of machines that are not ready, not there, or already as asked are left out.
 * `link up` on an unplugged NIC takes the lowest free port.
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
		const plug = life?.phase === "ready" ? life.plugs[nic] : undefined;
		return plug ? [{ machine, nic, plug }] : [];
	});
	const ports = claimPorts(state, up ? plugs.filter(({ plug }) => plug.kind === "none").length : 0);
	if (isPlanError(ports)) return ports;
	let claimed = 0;
	return plugs.flatMap(({ machine, nic, plug }): LinkChange[] => {
		if (plug.kind === "none") return up ? [{ machine, nic, up, port: ports[claimed++], newPort: true }] : [];
		return (plug.link === "up") === up ? [] : [{ machine, nic, up, port: plug.port, newPort: false }];
	});
}

export interface BootAgainPlan {
	readonly machine: MachineName;
	/** The lowest free ports, for the NICs that were spawned plugged in. */
	readonly ports: NicPorts;
}

/** Null unless the machine is failed. */
export function planBootAgain(state: LabState, machine: MachineName): BootAgainPlan | PlanError | null {
	const found = state.machines[machine];
	if (!found || !ACCEPTS[found.life.phase].bootAgain) return null;
	const ports = claimPorts(state, pluggedNics(found.spec.nics));
	return isPlanError(ports) ? ports : { machine, ports: nicPorts(found.spec.nics, ports) };
}

function claimPorts(state: LabState, wanted: number): readonly PortNo[] | PlanError {
	const ports = lowestFreePorts(state, wanted);
	return ports.length < wanted ? { kind: "no-ports", free: ports.length, wanted } : ports;
}

function samePlan(a: SpawnPlan, b: SpawnPlan): boolean {
	return (
		a.spec.image === b.spec.image &&
		a.spec.memMiB === b.spec.memMiB &&
		a.spec.cpus === b.spec.cpus &&
		a.spec.diskGiB === b.spec.diskGiB &&
		a.spec.nics.length === b.spec.nics.length &&
		a.spec.nics.every((nic, i) => nic.net === b.spec.nics[i].net) &&
		a.machines.length === b.machines.length &&
		a.machines.every((one, i) => {
			const other = b.machines[i];
			return (
				one.hue === other.hue &&
				samePorts(one.ports, other.ports) &&
				one.identity.n === other.identity.n &&
				one.identity.name === other.identity.name &&
				one.identity.ip === other.identity.ip &&
				one.identity.mac === other.identity.mac
			);
		})
	);
}

function samePorts(a: NicPorts, b: NicPorts): boolean {
	return a.length === b.length && a.every((port, i) => port === b[i]);
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
function cablesOf(life: Lifecycle): readonly { nic: NicNo; port: PortNo; link: "up" | "cut" }[] {
	const plugs = plugsOf(life);
	return NICS.flatMap((nic) => {
		const plug = plugs[nic];
		return plug?.kind === "port" ? [{ nic, port: plug.port, link: plug.link }] : [];
	});
}

/** Takes down every link that is up on the switch. Only a ready machine has any, because links come up at the first prompt. */
function linksDown({ name, life }: Machine, cause: Cause): Effect[] {
	if (life.phase !== "ready") return [];
	return cablesOf(life)
		.filter(({ link }) => link === "up")
		.map(({ port, nic }) => ({ type: "link/set", port, machine: name, nic, up: false, cause }));
}

/** The ports go on the switch before the kernel boots, so its first frame has somewhere to go. */
function bootEffects(machine: Machine, attempt: number, state: LabState): Effect[] {
	const { n, name, ip, mac, spec } = machine;
	return [
		...cablesOf(machine.life).map(({ port, nic }): Effect => ({ type: "port/attach", port, machine: name, nic })),
		{
			type: "vm/boot",
			machine: name,
			attempt,
			config: { identity: { n, name, ip, mac }, spec, hosts: hostsFor(state) },
		},
	];
}

/**
 * Adds every row at once, all booting, each with its console open. A plan
 * that is no longer what `planSpawn` would say (a stale or repeated event) is
 * ignored, so allocation has one owner.
 */
export function spawn(state: LabState, plan: SpawnPlan, at: number): Step {
	const fresh = planSpawn(state, plan.machines.length, plan.spec);
	if (isPlanError(fresh) || fresh.machines.length === 0 || !samePlan(fresh, plan)) return step(state);

	const nodes = fresh.machines.map(({ identity, hue, ports }) => ({
		identity,
		hue,
		spec: fresh.spec,
		plugs: plugInto(ports),
	}));
	return bootMachines(state, nodes, state.nextN + nodes.length, at);
}

export interface BootNode {
	failure?: string;
	identity: ReturnType<typeof identity>;
	hue: HueNo;
	spec: MachineSpec;
	plugs: readonly Plug[];
}

export function bootMachines(state: LabState, nodes: readonly BootNode[], nextN: number, at: number): Step {
	const machines = { ...state.machines };
	const sessions = { ...state.sessions };
	const added: Machine[] = [];
	for (const { identity: id, hue, spec, plugs, failure } of nodes) {
		const tab: SessionId = `${id.name}:console`;
		const machine: Machine = {
			...id,
			life:
				failure === undefined
					? { phase: "booting", attempt: 1, since: at, stage: "", plugs }
					: { phase: "failed", attempt: 1, reason: failure },
			hue,
			spec,
			sessions: [tab],
			activeSession: tab,
			nextShell: 1,
		};
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
		rail: [...state.rail, ...added.map((machine) => machine.name)],
	};
	const effects = added.flatMap((machine): Effect[] => [
		{ type: "screen/create", session: machine.activeSession },
		...(machine.life.phase === "booting" ? bootEffects(machine, 1, next) : []),
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
	for (const { nic, port, link } of cablesOf(machine.life)) {
		if (link === "up") effects.push({ type: "link/set", port, machine: name, nic, up: true, cause: "runtime" });
	}
	effects.push({ type: "hosts/publish", hosts: hostsFor(next) });
	return step(next, effects);
}

/**
 * A boot that errs or times out, or a ready guest that dies. The cables are
 * withdrawn and the ports freed. The console stays for scrolling back. Shells
 * die with the guest.
 */
export function fail(state: LabState, name: MachineName, attempt: number, reason: string): Step {
	const machine = onAttempt(state, name, attempt);
	if (!machine) return step(state);
	const { life } = machine;
	if (life.phase !== "booting" && life.phase !== "ready") return step(state);

	const [tab, ...shells] = machine.sessions;
	const effects: Effect[] = [...linksDown(machine, "runtime"), { type: "vm/stop", machine: name, attempt }];
	for (const port of portsOf(life)) effects.push({ type: "port/detach", port });
	for (const session of shells) effects.push({ type: "screen/dispose", session });
	effects.push({ type: "announce", text: [`${name} failed.`, reason].filter(Boolean).join(" ") });

	let sessions = state.sessions;
	for (const session of shells) sessions = without(sessions, session);
	const consoleSession = sessions[tab];
	if (consoleSession) sessions = { ...sessions, [tab]: patch(consoleSession, { shell: "unknown" }) };
	const failed: Machine = {
		...machine,
		life: { phase: "failed", attempt, reason },
		sessions: [tab],
		activeSession: tab,
	};
	return step(put({ ...state, sessions }, failed), effects);
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
		{ type: "vm/stop", machine: name, attempt: life.attempt },
	]);
}

/** Teardown has ended. The record goes, and its hue and ports are free again. */
export function gone(state: LabState, name: MachineName, attempt: number): Step {
	const machine = onAttempt(state, name, attempt);
	if (machine?.life.phase !== "removing") return step(state);
	let sessions = state.sessions;
	for (const session of machine.sessions) sessions = without(sessions, session);
	const next: LabState = {
		...state,
		machines: without(state.machines, name),
		rail: state.rail.filter((other) => other !== name),
		sessions,
	};
	const effects = portsOf(machine.life).map((port): Effect => ({ type: "port/detach", port }));
	for (const session of machine.sessions) effects.push({ type: "screen/dispose", session });
	effects.push({ type: "hosts/publish", hosts: hostsFor(next) }, { type: "announce", text: `${name} removed` });
	return step(next, effects);
}

/** Same name, hue, image and memory, on the planned ports. Ignored unless `ports` is still the plan. */
export function bootAgain(state: LabState, name: MachineName, ports: NicPorts, at: number): Step {
	const plan = planBootAgain(state, name);
	const machine = state.machines[name];
	if (!machine || plan === null || isPlanError(plan) || !samePorts(plan.ports, ports)) return step(state);
	const attempt = machine.life.attempt + 1;
	const plugs = plugInto(ports);
	const booting: Machine = { ...machine, life: { phase: "booting", attempt, since: at, stage: "", plugs } };
	const next = put({ ...state, now: later(state.now, at) }, booting);
	return step(next, bootEffects(booting, attempt, next));
}

export function link(state: LabState, changes: readonly LinkChange[], cause: Cause): Step {
	let result = step(state);
	for (const change of changes) result = andThen(result, (s) => linkOne(s, change, cause));
	return result;
}

function linkOne(state: LabState, change: LinkChange, cause: Cause): Step {
	const machine = state.machines[change.machine];
	if (machine?.life.phase !== "ready") return step(state);
	const { port, nic, up } = change;
	const plug = machine.life.plugs[nic];
	if (!plug) return step(state);
	const fits = change.newPort
		? up && plug.kind === "none" && lowestFreePorts(state, 1)[0] === port
		: plug.kind === "port" && plug.port === port && (plug.link === "up") !== up;
	if (!fits) return step(state);

	const set: Plug = { kind: "port", port, link: up ? "up" : "cut" };
	const next = put(state, {
		...machine,
		life: { ...machine.life, plugs: machine.life.plugs.map((other, i) => (i === nic ? set : other)) },
	});
	const effects: Effect[] = [];
	if (change.newPort) effects.push({ type: "port/attach", port, machine: machine.name, nic });
	effects.push(
		{ type: "link/set", port, machine: machine.name, nic, up, cause },
		{ type: "announce", text: `${nicLabel(machine, nic)} link ${up ? "up" : "down"}` },
	);
	return step(next, effects);
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
