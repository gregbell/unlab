import { MAX_NODE } from "../net/index.ts";
import { identity } from "./identity.ts";
import { type BootNode, bootMachines, machineList } from "./machines.ts";
import { addPanes, focusPane, keyboardHolder, parkPane, toggleMaximise } from "./panes.ts";
import { DISK_SIZES, HUES, type LabState, PORTS, type Step } from "./types.ts";

export function saveWorkspace(state: LabState): string {
	const nodes = machineList(state)
		.filter((m) => m.life.phase !== "removing")
		.map((m) => {
			const plug = m.life.phase === "ready" || m.life.phase === "booting" ? m.life.plug : null;
			return {
				n: m.n,
				hue: m.hue,
				...m.spec,
				port: plug?.kind === "port" ? plug.port : null,
				failure: m.life.phase === "failed" ? m.life.reason : undefined,
				cut: plug?.kind === "port" && plug.link === "cut",
			};
		});
	return JSON.stringify({
		version: 1,
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

export function restoreWorkspace(base: LabState, raw: string | null): Step {
	if (raw === null) return { state: base, effects: [] };
	const saved: unknown = JSON.parse(raw);
	if (!record(saved) || saved.version !== 1 || !Array.isArray(saved.nodes) || saved.nodes.length > HUES.length)
		return invalid();
	const nodes: BootNode[] = [];
	for (const m of saved.nodes as unknown[]) {
		if (!record(m)) return invalid();
		const cpus = m.cpus ?? 1;
		if (typeof cpus !== "number" || !Number.isInteger(cpus) || cpus < 1 || cpus > 16) return invalid();
		const hue = HUES.find((h) => h === m.hue);
		const port = PORTS.find((p) => p === m.port);
		const diskGiB = DISK_SIZES.find((d) => d === (m.diskGiB ?? "4"));
		if (
			!hue ||
			!diskGiB ||
			(m.port !== null && !port) ||
			typeof m.cut !== "boolean" ||
			typeof m.n !== "number" ||
			typeof m.image !== "string" ||
			typeof m.memMiB !== "number" ||
			!Number.isSafeInteger(m.memMiB) ||
			m.memMiB < 1 ||
			(m.net !== "none" && m.net !== "switch0") ||
			nodes.some(
				(node) =>
					node.identity.n === m.n || node.hue === hue || (port && node.plug.kind === "port" && node.plug.port === port),
			)
		)
			return invalid();
		nodes.push({
			identity: identity(m.n),
			failure: typeof m.failure === "string" ? m.failure : undefined,
			hue,
			spec: { image: m.image, net: m.net, memMiB: m.memMiB, diskGiB, cpus },
			plug: port ? { kind: "port", port, link: m.cut ? "cut" : "up" } : { kind: "none" },
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
