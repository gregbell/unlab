import { MAX_NODE } from "../net/index.ts";
import { identity } from "./identity.ts";
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

export function portOf(life: Lifecycle): PortNo | null {
	switch (life.phase) {
		case "booting":
		case "ready":
			return life.plug.kind === "port" ? life.plug.port : null;
		case "failed":
			return null;
		case "removing":
			return life.port;
	}
}

/** Cut cables and removing machines still hold their port. */
export function takenPorts(state: LabState): ReadonlySet<PortNo> {
	const taken = new Set<PortNo>();
	for (const machine of machineList(state)) {
		const port = portOf(machine.life);
		if (port !== null) taken.add(port);
	}
	return taken;
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
 * are the first free ones, ports the lowest free ones. The reducer applies
 * this plan and no other.
 */
export function planSpawn(state: LabState, count: number, spec: MachineSpec): SpawnPlan | PlanError {
	if (!state.images.some((image) => image.name === spec.image)) return { kind: "unknown-image", image: spec.image };
	const held = state.rail.length;
	const room = Math.max(0, Math.min(MAX_MACHINES - held, HUES.length - held, MAX_NODE + 1 - state.nextN));
	if (count > room) return { kind: "no-room", free: room, wanted: count };
	const ports = spec.net === "switch0" ? claimPorts(state, count) : null;
	if (ports !== null && isPlanError(ports)) return ports;
	const hues = firstFreeHues(state, count);
	return {
		machines: hues.map((hue, i) => ({
			identity: identity(state.nextN + i),
			hue,
			port: ports === null ? null : ports[i],
		})),
		spec,
	};
}

/**
 * The cables that would change. Machines that are not ready, not there, or
 * already as asked are left out. `link up` on an unplugged machine takes the
 * lowest free port.
 */
export function planLink(
	state: LabState,
	machines: readonly MachineName[],
	up: boolean,
): readonly LinkChange[] | PlanError {
	const plugs = [...new Set(machines)].flatMap((machine) => {
		const life = state.machines[machine]?.life;
		return life?.phase === "ready" ? [{ machine, plug: life.plug }] : [];
	});
	const ports = claimPorts(state, up ? plugs.filter(({ plug }) => plug.kind === "none").length : 0);
	if (isPlanError(ports)) return ports;
	let claimed = 0;
	return plugs.flatMap(({ machine, plug }): LinkChange[] => {
		if (plug.kind === "none") return up ? [{ machine, up, port: ports[claimed++], newPort: true }] : [];
		return (plug.link === "up") === up ? [] : [{ machine, up, port: plug.port, newPort: false }];
	});
}

export interface BootAgainPlan {
	readonly machine: MachineName;
	/** The lowest free port, or null for a machine spawned with `--no-net`. */
	readonly port: PortNo | null;
}

/** Null unless the machine is failed. */
export function planBootAgain(state: LabState, machine: MachineName): BootAgainPlan | PlanError | null {
	const found = state.machines[machine];
	if (!found || !ACCEPTS[found.life.phase].bootAgain) return null;
	if (found.spec.net === "none") return { machine, port: null };
	const ports = claimPorts(state, 1);
	return isPlanError(ports) ? ports : { machine, port: ports[0] };
}

/**
 * A machine holds at most one port and the lab holds as many machines as the
 * switch has ports, so today room runs out first and this never errs. It is
 * here for the day the two limits differ.
 */
function claimPorts(state: LabState, wanted: number): readonly PortNo[] | PlanError {
	const ports = lowestFreePorts(state, wanted);
	return ports.length < wanted ? { kind: "no-ports", free: ports.length, wanted } : ports;
}

function samePlan(a: SpawnPlan, b: SpawnPlan): boolean {
	return (
		a.spec.image === b.spec.image &&
		a.spec.memMiB === b.spec.memMiB &&
		a.spec.net === b.spec.net &&
		a.machines.length === b.machines.length &&
		a.machines.every((one, i) => {
			const other = b.machines[i];
			return (
				one.hue === other.hue &&
				one.port === other.port &&
				one.identity.n === other.identity.n &&
				one.identity.name === other.identity.name &&
				one.identity.ip === other.identity.ip &&
				one.identity.mac === other.identity.mac
			);
		})
	);
}

function put(state: LabState, machine: Machine): LabState {
	return { ...state, machines: { ...state.machines, [machine.name]: machine } };
}

/** The machine, if this event is about its current boot attempt. */
function onAttempt(state: LabState, name: MachineName, attempt: number): Machine | null {
	const machine = state.machines[name];
	return machine && machine.life.attempt === attempt ? machine : null;
}

/** The port whose link is up on the switch. Only a ready machine has one, because the link comes up at the first prompt. */
function livePort(life: Lifecycle): PortNo | null {
	return life.phase === "ready" && life.plug.kind === "port" && life.plug.link === "up" ? life.plug.port : null;
}

function linkDown(machine: Machine, cause: Cause): Effect[] {
	const port = livePort(machine.life);
	return port === null ? [] : [{ type: "link/set", port, machine: machine.name, up: false, cause }];
}

/** The port goes on the switch before the kernel boots, so its first frame has somewhere to go. */
function bootEffects(machine: Machine, attempt: number, state: LabState): Effect[] {
	const { n, name, ip, mac, spec } = machine;
	const port = portOf(machine.life);
	const boot: Effect = {
		type: "vm/boot",
		machine: name,
		attempt,
		config: { identity: { n, name, ip, mac }, spec, hosts: hostsFor(state) },
	};
	return port === null ? [boot] : [{ type: "port/attach", port, machine: name }, boot];
}

/**
 * Adds every row at once, all booting, each with its console open. A plan
 * that is no longer what `planSpawn` would say (a stale or repeated event) is
 * ignored, so allocation has one owner.
 */
export function spawn(state: LabState, plan: SpawnPlan, at: number): Step {
	const fresh = planSpawn(state, plan.machines.length, plan.spec);
	if (isPlanError(fresh) || fresh.machines.length === 0 || !samePlan(fresh, plan)) return step(state);

	const machines = { ...state.machines };
	const sessions = { ...state.sessions };
	const added: Machine[] = [];
	for (const { identity: id, hue, port } of fresh.machines) {
		const tab: SessionId = `${id.name}:console`;
		const plug: Plug = port === null ? UNPLUGGED : { kind: "port", port, link: "up" };
		const machine: Machine = {
			...id,
			life: { phase: "booting", attempt: 1, since: at, stage: "", plug },
			hue,
			spec: fresh.spec,
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
		nextN: state.nextN + added.length,
		machines,
		sessions,
		rail: [...state.rail, ...added.map((machine) => machine.name)],
	};
	const effects = added.flatMap((machine): Effect[] => [
		{ type: "screen/create", session: machine.activeSession },
		...bootEffects(machine, 1, next),
	]);
	return step(next, effects);
}

export function stage(state: LabState, name: MachineName, attempt: number, text: string): Step {
	const machine = onAttempt(state, name, attempt);
	if (machine?.life.phase !== "booting" || machine.life.stage === text) return step(state);
	return step(put(state, { ...machine, life: { ...machine.life, stage: text } }));
}

/** The first prompt. The link comes up now, not at spawn, so the port's light means eth0 is up. */
export function ready(state: LabState, name: MachineName, attempt: number, bootMs: number): Step {
	const machine = onAttempt(state, name, attempt);
	if (machine?.life.phase !== "booting") return step(state);
	const { plug } = machine.life;
	const next = put(state, { ...machine, life: { phase: "ready", attempt, bootMs, plug } });
	const effects: Effect[] = [{ type: "announce", text: `${name} ready` }];
	if (plug.kind === "port" && plug.link === "up") {
		effects.push({ type: "link/set", port: plug.port, machine: name, up: true, cause: "runtime" });
	}
	effects.push({ type: "hosts/publish", hosts: hostsFor(next) });
	return step(next, effects);
}

/**
 * A boot that errs or times out, or a ready guest that dies. The cable is
 * withdrawn and the port freed. The console stays for scrolling back. Shells
 * die with the guest.
 */
export function fail(state: LabState, name: MachineName, attempt: number, reason: string): Step {
	const machine = onAttempt(state, name, attempt);
	if (!machine) return step(state);
	const { life } = machine;
	if (life.phase !== "booting" && life.phase !== "ready") return step(state);

	const [tab, ...shells] = machine.sessions;
	const effects: Effect[] = [...linkDown(machine, "runtime"), { type: "vm/stop", machine: name, attempt }];
	if (life.plug.kind === "port") effects.push({ type: "port/detach", port: life.plug.port });
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

/** The link drops first, so neighbours see the machine leave. The port is held until it is gone. */
function removeOne(state: LabState, name: MachineName, cause: Cause): Step {
	const machine = state.machines[name];
	if (!machine || !ACCEPTS[machine.life.phase].remove) return step(state);
	const { life } = machine;
	const removing: Machine = { ...machine, life: { phase: "removing", attempt: life.attempt, port: portOf(life) } };
	return step(put(state, removing), [
		...linkDown(machine, cause),
		{ type: "vm/stop", machine: name, attempt: life.attempt },
	]);
}

/** Teardown has ended. The record goes, and its hue and port are free again. */
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
	const effects: Effect[] = [];
	if (machine.life.port !== null) effects.push({ type: "port/detach", port: machine.life.port });
	for (const session of machine.sessions) effects.push({ type: "screen/dispose", session });
	effects.push({ type: "hosts/publish", hosts: hostsFor(next) }, { type: "announce", text: `${name} removed` });
	return step(next, effects);
}

/** Same name, hue, image and memory, on the planned port. Ignored unless `port` is still the plan. */
export function bootAgain(state: LabState, name: MachineName, port: PortNo | null, at: number): Step {
	const plan = planBootAgain(state, name);
	const machine = state.machines[name];
	if (!machine || plan === null || isPlanError(plan) || plan.port !== port) return step(state);
	const attempt = machine.life.attempt + 1;
	const plug: Plug = port === null ? UNPLUGGED : { kind: "port", port, link: "up" };
	const booting: Machine = { ...machine, life: { phase: "booting", attempt, since: at, stage: "", plug } };
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
	const { plug } = machine.life;
	const { port, up } = change;
	const fits = change.newPort
		? up && plug.kind === "none" && lowestFreePorts(state, 1)[0] === port
		: plug.kind === "port" && plug.port === port && (plug.link === "up") !== up;
	if (!fits) return step(state);

	const next = put(state, {
		...machine,
		life: { ...machine.life, plug: { kind: "port", port, link: up ? "up" : "cut" } },
	});
	const effects: Effect[] = [];
	if (change.newPort) effects.push({ type: "port/attach", port, machine: machine.name });
	effects.push(
		{ type: "link/set", port, machine: machine.name, up, cause },
		{ type: "announce", text: `${machine.name} link ${up ? "up" : "down"}` },
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
