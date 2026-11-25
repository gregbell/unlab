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
	DEFAULT_SWITCH,
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
						port: plug?.kind === "port" ? plug.port.port : null,
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
		(saved.net !== "none" && saved.net !== DEFAULT_SWITCH)
	)
		return invalid();
	return {
		spec: { net: saved.net, address: readAddress(saved.address) },
		plug: port
			? { kind: "port", port: { switch: DEFAULT_SWITCH, port }, link: saved.cut ? "cut" : "up" }
			: { kind: "none" },
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

interface SavedNode extends Readonly<Record<string, unknown>> {
	readonly n: number;
}

interface SavedLab extends Readonly<Record<string, unknown>> {
	readonly nodes: readonly SavedNode[];
}

/** What changes of each machine. */
const eachNode =
	(change: (node: SavedNode) => Readonly<Record<string, unknown>>) =>
	(lab: SavedLab): SavedLab => ({ ...lab, nodes: lab.nodes.map((node) => ({ ...node, ...change(node) })) });

function savedNics({ nics }: SavedNode): readonly Readonly<Record<string, unknown>>[] {
	return Array.isArray(nics) ? nics.map((nic: unknown) => (record(nic) ? nic : invalid())) : invalid();
}

/** Each takes a lab from one version to the next, the first from version 1. */
const UPGRADES: readonly ((lab: SavedLab) => SavedLab)[] = [
	// A machine had one NIC, saved in the machine itself.
	eachNode(({ net, port, cut }) => ({ nics: [{ net, port, cut }] })),
	// It had no addresses, and no choice of gateway.
	eachNode((node) => {
		const [eth0, ...rest] = savedNics(node);
		if (!eth0) return invalid();
		const address = addressStr(defaultAddress(node.n));
		return {
			gateway: eth0.net === DEFAULT_SWITCH,
			nics: [{ ...eth0, address }, ...rest.map((nic) => ({ ...nic, address: null }))],
		};
	}),
	// It had no name.
	eachNode(({ n }) => ({ name: defaultName(n) })),
	// It had no extra disks.
	eachNode(({ diskGiB }) => ({ disks: { root: diskGiB ?? "4", extra: [] } })),
	// It had no checkpoints.
	eachNode(() => ({ sets: FIRST_SETS })),
];
const VERSION = UPGRADES.length + 1;

/** The lab as this version would have saved it. */
function readLab(raw: string): SavedLab {
	const saved: unknown = JSON.parse(raw);
	if (!record(saved) || !Array.isArray(saved.nodes) || saved.nodes.length > HUES.length) return invalid();
	const { version } = saved;
	if (!isCount(version) || version < 1 || version > VERSION) return invalid();
	const nodes = saved.nodes.map((node: unknown): SavedNode => {
		if (!record(node) || typeof node.n !== "number") return invalid();
		return { ...node, n: node.n };
	});
	return UPGRADES.slice(version - 1).reduce<SavedLab>((lab, upgrade) => upgrade(lab), { ...saved, nodes });
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
	const saved = readLab(raw);
	const nodes: BootNode[] = [];
	const taken = new Set<number>();
	for (const m of saved.nodes) {
		const id = readIdentity(m.n, m.name);
		const cpus = m.cpus ?? 1;
		if (typeof cpus !== "number" || !Number.isInteger(cpus) || cpus < 1 || cpus > 16) return invalid();
		const hue = HUES.find((h) => h === m.hue);
		const nics = readNics(m.nics);
		for (const { plug } of nics) {
			if (plug.kind === "none") continue;
			if (taken.has(plug.port.port)) return invalid();
			taken.add(plug.port.port);
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
