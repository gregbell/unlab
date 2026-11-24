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
import { identity, parseMachineName } from "./identity.ts";
import { type BootNode, bootMachines, machineList, plugsOf } from "./machines.ts";
import { addPanes, focusPane, keyboardHolder, parkPane, toggleMaximise } from "./panes.ts";
import { DISK_SIZES, HUES, type Identity, type LabState, type NicSpec, type Plug, PORTS, type Step } from "./types.ts";

/** 1 had one NIC, saved in the machine itself. 2 had no addresses and no choice of gateway. 3 had no names. */
const VERSIONS = [1, 2, 3, 4] as const;
type Version = (typeof VERSIONS)[number];
const VERSION = 4;

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

/** A machine as this version would have saved it. */
function upgraded(version: Version, machine: Record<string, unknown>, n: number): Record<string, unknown> {
	if (version === VERSION) return machine;
	const named = { ...machine, name: defaultName(n) };
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
		const diskGiB = DISK_SIZES.find((d) => d === (m.diskGiB ?? "4"));
		if (
			!hue ||
			!diskGiB ||
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
			hue,
			spec: {
				image: m.image,
				memMiB: m.memMiB,
				diskGiB,
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
			dock: saved.dock === "collapsed" ? "collapsed" : "open",
			agent: { ...base.agent, policies, paused: saved.paused === true },
		},
	};
}
