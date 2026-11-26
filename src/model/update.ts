import { cable, linkCables, storm, uncable } from "./cables.ts";
import { setConditions, settleConditions } from "./conditions.ts";
import { parseSessionId } from "./identity.ts";
import {
	bootStopped,
	checkpointProgress,
	checkpointSaved,
	checkpointUnsaved,
	expireBoots,
	fail,
	forget,
	halted,
	link,
	machineList,
	nicLost,
	openShell,
	plug,
	power,
	ready,
	remove,
	restore,
	restored,
	saveCheckpoint,
	selectTab,
	sessionEnded,
	sessionMarked,
	sessionOpened,
	sessionShell,
	spawn,
	stage,
	stopped,
} from "./machines.ts";
import { ALL_OPEN, maximisePanel, parkPanel, restorePanels, toggleMaximisedPanel, unparkPanel } from "./panels.ts";
import {
	addPanes,
	emptyPanes,
	focusPane,
	gridFor,
	keyboardHolder,
	lastFocused,
	parkPane,
	promotePane,
	removePane,
	resizeArea,
	toggleMaximise,
	visiblePanes,
} from "./panes.ts";
import { later, patch, step } from "./step.ts";
import { addSwitch, removeSwitch, showSwitch } from "./switches.ts";
import {
	type AgentCall,
	type AgentState,
	type CaptureUi,
	type CliLink,
	DEFAULT_SWITCH,
	type ImageInfo,
	type Keyboard,
	type LabEvent,
	type LabState,
	LOG_LIMIT,
	type LogEntry,
	type MachineName,
	type Panels,
	type Panes,
	type Policy,
	type SessionId,
	type Step,
	type ToolName,
	type WebMcp,
} from "./types.ts";
import { settleVlans, setVlan } from "./vlans.ts";

/**
 * Every tool runs at once except spawn, which takes the browser's memory and
 * storage, and those that take from the lab: removing a machine or a switch, and
 * going back to a checkpoint or deleting one. Power does neither: the disks and the cables stay, and a guest can be rebooted from
 * the shell that `shell_exec` types into. A file can be written from it too.
 */
export const DEFAULT_POLICIES: Readonly<Record<ToolName, Policy>> = {
	lab_help: "run",
	machines_list: "run",
	topology_read: "run",
	machines_spawn: "ask",
	machines_boot: "run",
	machines_reboot: "run",
	machines_poweroff: "run",
	machines_remove: "ask",
	switch_add: "run",
	switch_remove: "ask",
	switch_cable: "run",
	switch_uncable: "run",
	port_vlan: "run",
	port_trunk: "run",
	checkpoint_save: "run",
	checkpoint_restore: "ask",
	checkpoint_remove: "ask",
	shell_exec: "run",
	shell_read: "run",
	file_write: "run",
	link_set: "run",
	cable_plug: "run",
	cable_unplug: "run",
	capture_read: "run",
};

const NOWHERE: Keyboard = { kind: "none" };

export function initialState(
	images: readonly ImageInfo[],
	area: { readonly width: number; readonly height: number },
): LabState {
	return {
		now: 0,
		nextN: 1,
		machines: {},
		rail: [],
		departed: {},
		departedSwitches: [],
		switches: [DEFAULT_SWITCH],
		shownSwitch: DEFAULT_SWITCH,
		switchCables: [],
		portVlans: [],
		storms: {},
		sessions: {},
		panes: emptyPanes(gridFor(area.width, area.height)),
		keyboard: NOWHERE,
		view: "lab",
		agentPanel: false,
		panels: ALL_OPEN,
		capture: { filter: "", paused: false, selected: null },
		agent: {
			webmcp: { kind: "absent" },
			policies: DEFAULT_POLICIES,
			paused: false,
			calls: [],
			firstCallAt: null,
			lastCallAt: null,
		},
		cli: { kind: "off" },
		log: [],
		nextLogId: 1,
		images,
	};
}

/** How often `tick` should arrive. Ten times a second while a boot counter counts tenths, once a second otherwise. */
export function clockHz(state: LabState): 1 | 10 {
	return machineList(state).some((machine) => machine.life.phase === "booting") ? 10 : 1;
}

/**
 * The only way the lab changes. It is total. An event about a machine that
 * is not there, a boot attempt that was replaced, or a phase that does not
 * accept it returns the same state object and no effects, so a late or
 * repeated message is harmless.
 */
export function update(state: LabState, event: LabEvent): Step {
	const reduced = reduce(state, event);
	return reduced.state === state ? reduced : settle(state, reduced);
}

function reduce(state: LabState, event: LabEvent): Step {
	switch (event.type) {
		case "tick":
			return expireBoots(patch(state, { now: later(state.now, event.now) }));
		case "vm/stage":
			return stage(state, event.machine, event.attempt, event.stage);
		case "vm/ready":
			return ready(state, event.machine, event.attempt, event.bootMs);
		case "vm/failed":
			return fail(state, event.machine, event.attempt, event.reason);
		case "vm/stopped":
			return stopped(state, event.machine, event.attempt, event.clean, event.at);
		case "vm/halted":
			return halted(state, event.machine, event.attempt, event.next, event.closed);
		case "vm/nic-lost":
			return nicLost(state, event.machine, event.attempt, event.nic, event.reason);
		case "checkpoint/progress":
			return checkpointProgress(state, event.machine, event.attempt, event.set, event.percent);
		case "checkpoint/saved":
			return checkpointSaved(state, event.machine, event.attempt, event.set, event.bytes);
		case "checkpoint/unsaved":
			return checkpointUnsaved(state, event.machine, event.attempt, event.set, event.reason);
		case "checkpoint/restored":
			return restored(state, event.machine, event.attempt, event.set, event.at);
		case "switch/storm":
			return storm(state, event.switch, event.storm);
		case "session/opened":
			return sessionOpened(state, event.session);
		case "session/ended":
			return sessionEnded(state, event.session);
		case "session/shell":
			return sessionShell(state, event.session, event.shell);
		case "session/marked":
			return sessionMarked(state, event.session, event.source);

		case "cmd/spawn": {
			const spawned = spawn(state, event.plan, event.at);
			// Booting is one of the ways the Add machines view closes.
			return spawned.state !== state && state.view === "spawn"
				? step({ ...spawned.state, view: "lab" }, spawned.effects)
				: spawned;
		}
		case "cmd/remove":
			return remove(state, event.machines, event.cause);
		case "cmd/switch-add":
			return addSwitch(state, event.plan);
		case "cmd/switch-remove":
			return removeSwitch(state, event.switch, event.cause);
		case "cmd/boot":
			return bootStopped(state, event.machines, event.at);
		case "cmd/power":
			return power(state, event.machines, event.next);
		case "cmd/checkpoint":
			return saveCheckpoint(state, event.machine, event.name);
		case "cmd/restore":
			return restore(state, event.plan);
		case "cmd/forget":
			return forget(state, event.machine, event.set);
		case "cmd/link":
			return link(state, event.changes, event.cause);
		case "cmd/plug":
			return plug(state, event.plan, event.cause);
		case "cmd/cable":
			return cable(state, event.plan, event.cause);
		case "cmd/uncable":
			return uncable(state, event.port, event.cause);
		case "cmd/cable-link":
			return linkCables(state, event.changes, event.cause);
		case "cmd/vlan":
			return setVlan(state, event.port, event.vlan);
		case "cmd/conditions":
			return setConditions(state, event.changes);
		case "cmd/shell":
			return shell(state, event.machine);
		case "cmd/focus":
			return focus(state, event.target, event.mode);
		case "cmd/capture":
			return step(
				patch(capture(state, { filter: event.filter }), {
					view: "lab",
					panels: maximisePanel(state.panels, "capture"),
				}),
			);
		case "cmd/logged":
			return step(logged(state, { line: event.line, source: event.source, at: event.at, outcome: event.outcome }));

		case "ui/pane-focused":
		case "ui/unpark":
			return showPane(state, event.machine, focusPane(state.panes, event.machine));
		case "ui/maximise":
			return showPane(state, event.machine, toggleMaximise(focusPane(state.panes, event.machine), event.machine));
		case "ui/tab-selected":
			return selectTab(state, event.session);
		case "ui/park":
			return step(patch(state, { panes: parkPane(state.panes, event.machine) }));
		case "ui/area-resized":
			return step(patch(state, { panes: resizeArea(state.panes, event.width, event.height) }));
		case "ui/view":
			return step(patch(state, { view: event.view }));
		case "ui/agent-panel":
			return step(patch(state, { agentPanel: event.open }));
		case "ui/panel-unparked":
			return panels(state, unparkPanel(state.panels, event.panel));
		case "ui/panel-parked":
			return panels(state, parkPanel(state.panels, event.panel));
		case "ui/panel-maximised":
			return panels(state, toggleMaximisedPanel(state.panels, event.panel));
		case "ui/switch-shown":
			return step(showSwitch(state, event.switch));
		case "ui/bar":
			return event.open ? openBar(state) : closeBar(state);
		case "ui/capture-filter":
			return step(capture(state, { filter: event.filter }));
		case "ui/capture-pause":
			return step(capture(state, { paused: event.paused }));
		case "ui/capture-clear":
			return step(capture(state, { selected: null }), [{ type: "capture/clear" }]);
		case "ui/frame-selected":
			return step(capture(state, { selected: event.seq }));
		case "ui/policy":
			return state.agent.policies[event.tool] === event.policy
				? step(state)
				: step(agent(state, { policies: { ...state.agent.policies, [event.tool]: event.policy } }));
		case "ui/tools-paused":
			return step(agent(state, { paused: event.paused }));

		case "agent/webmcp":
			return sameWebMcp(state.agent.webmcp, event.webmcp) ? step(state) : step(agent(state, { webmcp: event.webmcp }));
		case "agent/call":
			return agentCalled(state, event.call);
		case "agent/settled":
			return agentSettled(state, event.id, event.status, event.result);

		case "cli/link":
			return sameCliLink(state.cli, event.cli) ? step(state) : step(patch(state, { cli: event.cli }));
	}
}

/**
 * What must hold after every change, kept in one place. Each machine has a
 * pane and no pane outlives its machine. No panel stays maximised once the
 * last machine is gone, or it would hide the next one. The keyboard is on a
 * visible pane whenever there is one. A port that nothing is in is in VLAN 1,
 * and the switches treat each cable's frames as the lab has its conditions.
 * The clock runs fast only while something boots.
 */
function settle(before: LabState, reduced: Step): Step {
	const vlans = settleVlans(before, reduced.state);
	const state = settleKeyboard(followMachines(vlans.state));
	const effects = [...reduced.effects, ...vlans.effects, ...settleConditions(before, state)];
	const hz = clockHz(state);
	return hz === clockHz(before) ? step(state, effects) : step(state, [...effects, { type: "clock", hz }]);
}

function followMachines(state: LabState): LabState {
	let panes = state.panes;
	for (const name of panes.order) if (!state.machines[name]) panes = removePane(panes, name);
	return patch(state, {
		panes: addPanes(panes, state.rail),
		panels: state.rail.length === 0 ? restorePanels(state.panels) : state.panels,
	});
}

/** When the pane that held the keyboard parks or goes, the visible pane focused before it takes over. */
function settleKeyboard(state: LabState): LabState {
	const { keyboard, panes } = state;
	const visible = visiblePanes(panes);
	const holder = keyboardHolder(keyboard);
	if (holder !== null && visible.includes(holder)) return state;
	const heir = lastFocused(panes, visible) ?? (visible.length > 0 ? visible[0] : null);
	if (keyboard.kind === "bar") return withKeyboard(state, { kind: "bar", returnTo: heir });
	if (heir === null) return withKeyboard(state, NOWHERE);
	return withKeyboard(patch(state, { panes: focusPane(panes, heir) }), { kind: "pane", machine: heir });
}

function withKeyboard(state: LabState, keyboard: Keyboard): LabState {
	const same = state.keyboard.kind === keyboard.kind && keyboardHolder(state.keyboard) === keyboardHolder(keyboard);
	return same ? state : { ...state, keyboard };
}

/** Focus was seen or asked for in a pane, so the pane has the keyboard now, whatever had it before. */
function takeKeyboard(state: LabState, name: MachineName, panes: Panes): Step {
	if (!state.machines[name]) return step(state);
	return step(withKeyboard(patch(state, { panes }), { kind: "pane", machine: name }));
}

/** As `takeKeyboard`, for a pane asked for by name, which a maximised panel must not cover. */
function showPane(state: LabState, name: MachineName, panes: Panes): Step {
	return takeKeyboard(state.machines[name] ? uncovered(state) : state, name, panes);
}

/** With no panel over the panes. */
const uncovered = (state: LabState): LabState => patch(state, { panels: restorePanels(state.panels) });

const panels = (state: LabState, next: Panels): Step => step(patch(state, { panels: next }));

/** `sh`. The new shell takes the keyboard, so its pane comes out from under a maximised panel. */
function shell(state: LabState, name: MachineName): Step {
	const opened = openShell(state, name);
	return opened.state === state ? opened : step(uncovered(opened.state), opened.effects);
}

/**
 * `focus`, from the bar or a rail row. A session target also selects its tab.
 * While the bar is open it keeps the keyboard and this decides where it returns.
 */
function focus(state: LabState, target: MachineName | SessionId, mode: "plain" | "main" | "max"): Step {
	const address = parseSessionId(target);
	const name = machineList(state).find((machine) => machine.name === (address?.machine ?? target))?.name;
	if (!name || (address && !state.sessions[address.session])) return step(state);
	const tabbed = address ? selectTab(state, address.session).state : state;
	const promoted = mode === "main" ? promotePane(tabbed.panes, name) : tabbed.panes;
	// Focus before maximising, so the layout that maximise restores has this pane in it.
	const focused = focusPane(promoted, name);
	const panes = mode === "max" ? toggleMaximise(focused, name) : focused;
	const keyboard: Keyboard =
		tabbed.keyboard.kind === "bar" ? { kind: "bar", returnTo: name } : { kind: "pane", machine: name };
	return step(withKeyboard(patch(uncovered(tabbed), { panes }), keyboard));
}

function openBar(state: LabState): Step {
	if (state.keyboard.kind === "bar") return step(state);
	return step({ ...state, keyboard: { kind: "bar", returnTo: keyboardHolder(state.keyboard) } });
}

function closeBar(state: LabState): Step {
	if (state.keyboard.kind !== "bar") return step(state);
	const back = state.keyboard.returnTo;
	if (back === null || !state.machines[back]) return step({ ...state, keyboard: NOWHERE });
	return takeKeyboard(state, back, focusPane(state.panes, back));
}

function capture(state: LabState, fields: Partial<CaptureUi>): LabState {
	return patch(state, { capture: patch(state.capture, fields) });
}

function agent(state: LabState, fields: Partial<AgentState>): LabState {
	return patch(state, { agent: patch(state.agent, fields) });
}

function sameCliLink(a: CliLink, b: CliLink): boolean {
	return a.kind === b.kind && (a.kind !== "refused" || b.kind !== "refused" || a.message === b.message);
}

function sameWebMcp(a: WebMcp, b: WebMcp): boolean {
	return a.kind === "refused" && b.kind === "refused" ? a.message === b.message : a.kind === b.kind;
}

function logged(state: LabState, entry: Omit<LogEntry, "id">): LabState {
	return {
		...state,
		now: later(state.now, entry.at),
		log: [...state.log, { id: state.nextLogId, ...entry }].slice(-LOG_LIMIT),
		nextLogId: state.nextLogId + 1,
	};
}

/** At most LOG_LIMIT calls, dropping the oldest finished ones first. A call still waiting or running stays. */
function bounded(calls: readonly AgentCall[]): readonly AgentCall[] {
	let excess = calls.length - LOG_LIMIT;
	if (excess <= 0) return calls;
	return calls.filter((call) => {
		if (excess <= 0 || call.status === "waiting" || call.status === "running") return true;
		excess--;
		return false;
	});
}

/** A call that waits opens the agent panel: that is where it is answered, and the agent is stuck until it is. */
function agentCalled(state: LabState, call: AgentCall): Step {
	const { calls, firstCallAt, lastCallAt } = state.agent;
	if (calls.some((known) => known.id === call.id)) return step(state);
	const next = agent(
		{ ...state, now: later(state.now, call.at) },
		{
			calls: bounded([...calls, call]),
			firstCallAt: firstCallAt ?? call.at,
			lastCallAt: later(lastCallAt ?? call.at, call.at),
		},
	);
	const waiting = call.status === "waiting";
	if (!waiting) return step(next);
	return step(patch(next, { agentPanel: true }), [
		{ type: "announce", text: `Agent call waiting for you: ${call.line}` },
	]);
}

/** A call settles once. Before that it may go from waiting to running, never back. */
function agentSettled(state: LabState, id: number, status: AgentCall["status"], result: string | null): Step {
	const call = state.agent.calls.find((known) => known.id === id);
	const pending = call?.status === "waiting" || call?.status === "running";
	if (!call || !pending || status === "waiting") return step(state);
	const settled = patch(call, { status, result });
	if (settled === call) return step(state);
	return step(agent(state, { calls: state.agent.calls.map((known) => (known === call ? settled : known)) }));
}
