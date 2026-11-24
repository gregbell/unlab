import { MAX_NICS, MAX_NODE } from "../net/index.ts";
import { identity } from "./identity.ts";
import { type BootNode, bootMachines, machineList, plugsOf } from "./machines.ts";
import { addPanes, focusPane, keyboardHolder, parkPane, toggleMaximise } from "./panes.ts";
import { DISK_SIZES, HUES, type LabState, type NicSpec, type Plug, PORTS, type Step } from "./types.ts";

const VERSION = 2;

export function saveWorkspace(state: LabState): string {
	const nodes = machineList(state)
		.filter((m) => m.life.phase !== "removing")
		.map((m) => {
			const plugs = plugsOf(m.life);
			return {
				n: m.n,
				hue: m.hue,
				...m.spec,
				nics: m.spec.nics.map((nic, k) => {
					const plug = plugs[k];
					return plug?.kind === "port"
						? { ...nic, port: plug.port, cut: plug.link === "cut" }
						: { ...nic, port: null, cut: false };
				}),
				failure: m.life.phase === "failed" ? m.life.reason : undefined,
			};
		});
	return JSON.stringify({
		version: VERSION,
		nextN: state.nextN,
		nodes,
		dock: state.dock,
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
		spec: { net: saved.net },
		plug: port ? { kind: "port", port, link: saved.cut ? "cut" : "up" } : { kind: "none" },
	};
}

/** Version 1 machines had one NIC, saved in the machine itself. */
function readNics(version: unknown, machine: Record<string, unknown>): readonly SavedNic[] {
	const saved = version === 1 ? [machine] : machine.nics;
	if (!Array.isArray(saved) || saved.length < 1 || saved.length > MAX_NICS) return invalid();
	return saved.map(readNic);
}

export function restoreWorkspace(base: LabState, raw: string | null): Step {
	if (raw === null) return { state: base, effects: [] };
	const saved: unknown = JSON.parse(raw);
	if (
		!record(saved) ||
		(saved.version !== 1 && saved.version !== VERSION) ||
		!Array.isArray(saved.nodes) ||
		saved.nodes.length > HUES.length
	)
		return invalid();
	const nodes: BootNode[] = [];
	const taken = new Set<number>();
	for (const m of saved.nodes as unknown[]) {
		if (!record(m)) return invalid();
		const cpus = m.cpus ?? 1;
		if (typeof cpus !== "number" || !Number.isInteger(cpus) || cpus < 1 || cpus > 16) return invalid();
		const hue = HUES.find((h) => h === m.hue);
		const nics = readNics(saved.version, m);
		for (const { plug } of nics) {
			if (plug.kind === "none") continue;
			if (taken.has(plug.port)) return invalid();
			taken.add(plug.port);
		}
		const diskGiB = DISK_SIZES.find((d) => d === (m.diskGiB ?? "4"));
		if (
			!hue ||
			!diskGiB ||
			typeof m.n !== "number" ||
			typeof m.image !== "string" ||
			typeof m.memMiB !== "number" ||
			!Number.isSafeInteger(m.memMiB) ||
			m.memMiB < 1 ||
			nodes.some((node) => node.identity.n === m.n || node.hue === hue)
		)
			return invalid();
		nodes.push({
			identity: identity(m.n),
			failure: typeof m.failure === "string" ? m.failure : undefined,
			hue,
			spec: { image: m.image, memMiB: m.memMiB, diskGiB, cpus, nics: nics.map((nic) => nic.spec) },
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
			dock: saved.dock === "collapsed" ? "collapsed" : "open",
			agent: { ...base.agent, policies, paused: saved.paused === true },
		},
	};
}
