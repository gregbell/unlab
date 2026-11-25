import {
	addressStr,
	defaultAddress,
	defaultName,
	isAddressFault,
	MAX_NICS,
	MAX_NODE,
	parseAddress,
	parseDefaultName,
} from "../net/index.ts";
import { FIRST_SETS, MAX_EXTRA_DISKS, parseGiB } from "./disks.ts";
import { identity, parseCheckpointName, parseMachineName } from "./identity.ts";
import { type BootNode, bootMachines, machineList, plugsOf } from "./machines.ts";
import { addPanes, focusPane, keyboardHolder, parkPane, toggleMaximise } from "./panes.ts";
import {
	type Checkpoint,
	DISK_SIZES,
	type DiskSets,
	type Disks,
	HUES,
	type Identity,
	type LabState,
	type NicSpec,
	PANELS,
	type PanelName,
	type Plug,
	PORTS,
	type Step,
} from "./types.ts";

/** 1 had one NIC, saved in the machine itself. 2 had no addresses and no choice of gateway. 3 had no names. 4 had no extra disks. 5 had no checkpoints. */
const VERSIONS = [1, 2, 3, 4, 5, 6] as const;
type Version = (typeof VERSIONS)[number];
const VERSION = 6;

export function saveWorkspace(state: LabState): string {
	const nodes = machineList(state)
		.filter((m) => m.life.phase !== "removing")
		.map((m) => {
			const plugs = plugsOf(m.life);
			return {
				n: m.n,
				name: m.name,
				hue: m.hue,
				...m.spec,
				nics: m.spec.nics.map((nic, k) => {
					const plug = plugs[k];
					return {
						net: nic.net,
						address: nic.address ? addressStr(nic.address) : null,
						port: plug?.kind === "port" ? plug.port : null,
						cut: plug?.kind === "port" && plug.link === "cut",
					};
				}),
				failure: m.life.phase === "failed" ? m.life.reason : undefined,
				sets: m.sets,
				// A restore that a reload cuts short is done again from the start, and one that is not in here never was.
				restore: m.life.phase === "restoring" ? m.life.from.set : undefined,
				// A stop that a reload cuts short ends as it was going to.
				off: m.life.phase === "off" || (m.life.phase === "stopping" && m.life.next === "off") ? true : undefined,
			};
		});
	return JSON.stringify({
		version: VERSION,
		nextN: state.nextN,
		nodes,
		panels: state.panels.open,
		order: state.panes.order,
		parked: state.panes.order.filter((n) => (state.panes.maximised?.before ?? state.panes.parked)[n] === "user"),
		maximised: state.panes.maximised?.machine,
		focus: keyboardHolder(state.keyboard),
		policies: state.agent.policies,
		paused: state.agent.paused,
	});
}

const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
function invalid(): never {
	throw new Error("The saved Unlab workspace could not be read. Its disks and settings have been kept.");
}

interface SavedNic {
	readonly spec: NicSpec;
	readonly plug: Plug;
}

function readNic(saved: unknown): SavedNic {
	if (!record(saved)) return invalid();
	const port = PORTS.find((p) => p === saved.port);
	if (
		(saved.port !== null && !port) ||
		typeof saved.cut !== "boolean" ||
		(saved.net !== "none" && saved.net !== "switch0")
	)
		return invalid();
	return {
		spec: { net: saved.net, address: readAddress(saved.address) },
		plug: port ? { kind: "port", port, link: saved.cut ? "cut" : "up" } : { kind: "none" },
	};
}

function readAddress(saved: unknown): NicSpec["address"] {
	if (saved === null) return null;
	const address = typeof saved === "string" ? parseAddress(saved) : invalid();
	return isAddressFault(address) ? invalid() : address;
}

function readNics(saved: unknown): readonly SavedNic[] {
	if (!Array.isArray(saved) || saved.length < 1 || saved.length > MAX_NICS) return invalid();
	return saved.map(readNic);
}

function readDisks(saved: unknown): Disks {
	if (!record(saved) || !Array.isArray(saved.extra) || saved.extra.length > MAX_EXTRA_DISKS) return invalid();
	return {
		root: DISK_SIZES.find((size) => size === saved.root) ?? invalid(),
		extra: saved.extra.map((size) => parseGiB(size) ?? invalid()),
	};
}

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

function readCheckpoint(saved: unknown): Checkpoint {
	if (!record(saved)) return invalid();
	const name = typeof saved.name === "string" ? parseCheckpointName(saved.name) : null;
	const { set, bytes } = saved;
	return name && isCount(set) && isCount(bytes) ? { name, set, bytes } : invalid();
}

function readSets(saved: unknown): DiskSets {
	if (!record(saved) || !isCount(saved.live) || !isCount(saved.next) || !Array.isArray(saved.checkpoints))
		return invalid();
	const { live, next } = saved;
	const checkpoints = saved.checkpoints.map(readCheckpoint);
	const sets = [live, ...checkpoints.map(({ set }) => set)];
	const names = checkpoints.map(({ name }) => name);
	const distinct = new Set(sets).size === sets.length && new Set(names).size === names.length;
	return distinct && sets.every((set) => set < next) ? { live, next, checkpoints } : invalid();
}

function readRestore(saved: unknown, { checkpoints }: DiskSets): Checkpoint | undefined {
	return saved === undefined ? undefined : (checkpoints.find(({ set }) => set === saved) ?? invalid());
}

/** A machine as this version would have saved it. */
function upgraded(version: Version, machine: Record<string, unknown>, n: number): Record<string, unknown> {
	if (version === VERSION) return machine;
	const numbered = { ...machine, sets: FIRST_SETS };
	if (version === 5) return numbered;
	const disked = { ...numbered, disks: { root: machine.diskGiB ?? "4", extra: [] } };
	if (version === 4) return disked;
	const named = { ...disked, name: defaultName(n) };
	if (version === 3) return named;
	const nics: unknown = version === 1 ? [machine] : machine.nics;
	if (!Array.isArray(nics)) return invalid();
	const [eth0, ...rest] = nics.map((nic: unknown) => (record(nic) ? nic : invalid()));
	if (!eth0) return invalid();
	return {
		...named,
		gateway: eth0.net === "switch0",
		nics: [{ ...eth0, address: addressStr(defaultAddress(n)) }, ...rest.map((nic) => ({ ...nic, address: null }))],
	};
}

/** `node<n>` names machine n and no other, as it does when the lab gives it out. */
function readIdentity(n: number, saved: unknown): Identity {
	const name = (typeof saved === "string" ? parseMachineName(saved) : null) ?? invalid();
	return [n, null].includes(parseDefaultName(name)) ? identity(n, name) : invalid();
}

/** Before panels parked one at a time, one `dock` was open or collapsed. */
function readPanels(saved: Record<string, unknown>): readonly PanelName[] {
	const { panels, dock } = saved;
	if (Array.isArray(panels)) return PANELS.filter((name) => panels.includes(name));
	return dock === "collapsed" ? [] : PANELS;
}

export function restoreWorkspace(base: LabState, raw: string | null): Step {
	if (raw === null) return { state: base, effects: [] };
	const saved: unknown = JSON.parse(raw);
	if (!record(saved) || !Array.isArray(saved.nodes) || saved.nodes.length > HUES.length) return invalid();
	const version = VERSIONS.find((v) => v === saved.version) ?? invalid();
	const nodes: BootNode[] = [];
	const taken = new Set<number>();
	for (const node of saved.nodes as unknown[]) {
		if (!record(node)) return invalid();
		const n = typeof node.n === "number" ? node.n : invalid();
		const m = upgraded(version, node, n);
		const id = readIdentity(n, m.name);
		const cpus = m.cpus ?? 1;
		if (typeof cpus !== "number" || !Number.isInteger(cpus) || cpus < 1 || cpus > 16) return invalid();
		const hue = HUES.find((h) => h === m.hue);
		const nics = readNics(m.nics);
		for (const { plug } of nics) {
			if (plug.kind === "none") continue;
			if (taken.has(plug.port)) return invalid();
			taken.add(plug.port);
		}
		const disks = readDisks(m.disks);
		const sets = readSets(m.sets);
		if (
			!hue ||
			typeof m.gateway !== "boolean" ||
			typeof m.image !== "string" ||
			typeof m.memMiB !== "number" ||
			!Number.isSafeInteger(m.memMiB) ||
			m.memMiB < 1 ||
			nodes.some((node) => node.identity.n === id.n || node.identity.name === id.name || node.hue === hue)
		)
			return invalid();
		nodes.push({
			identity: id,
			failure: typeof m.failure === "string" ? m.failure : undefined,
			off: m.off === true,
			sets,
			restore: readRestore(m.restore, sets),
			hue,
			spec: {
				image: m.image,
				memMiB: m.memMiB,
				disks,
				cpus,
				gateway: m.gateway,
				nics: nics.map((nic) => nic.spec),
			},
			plugs: nics.map((nic) => nic.plug),
		});
	}
	if (
		typeof saved.nextN !== "number" ||
		!Number.isInteger(saved.nextN) ||
		saved.nextN > MAX_NODE + 1 ||
		saved.nextN <= Math.max(0, ...nodes.map((n) => n.identity.n))
	)
		return invalid();
	const { state, effects } = bootMachines(base, nodes, saved.nextN, 0);
	const order = Array.isArray(saved.order) ? saved.order : [];
	const sorted = [...state.rail].sort((a, b) => order.indexOf(a) - order.indexOf(b));
	let panes = addPanes(base.panes, sorted);
	for (const n of state.rail) if (Array.isArray(saved.parked) && saved.parked.includes(n)) panes = parkPane(panes, n);
	const focus =
		state.rail.find((n) => n === saved.focus && panes.parked[n] !== "user") ??
		panes.order.find((n) => !panes.parked[n]);
	if (focus) panes = focusPane(panes, focus);
	if (focus && saved.maximised === focus) panes = toggleMaximise(panes, focus);
	const policies = { ...base.agent.policies };
	if (record(saved.policies))
		for (const key of Object.keys(policies) as (keyof typeof policies)[]) {
			const p = saved.policies[key];
			if (p === "ask" || p === "off" || p === "run") policies[key] = p;
		}
	return {
		effects,
		state: {
			...state,
			panes,
			keyboard: focus ? { kind: "pane", machine: focus } : { kind: "none" },
			panels: { ...base.panels, open: readPanels(saved) },
			agent: { ...base.agent, policies, paused: saved.paused === true },
		},
	};
}
