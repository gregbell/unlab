// Prints all that a person or an agent reads from the commands: help, completions, tool descriptions and schemas, and what
// a recorded set of lines answers on labs of one switch. Run it on two checkouts and compare the output byte for byte.
//
//   node --experimental-transform-types .audit/phase2/surface.mjs <checkout> > before.txt

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(process.argv[2]);
const from = (file) => import(join(root, "src", file));
const { storeLab } = await from("commands/testing/store.ts");
const { completeLine, createRegistry, VERBS, isLineError, parseLine } = await from("commands/index.ts");
const { toolTable } = await from("agent/tools.ts");
const { createCaptureLog, formatCounters } = await from("capture/index.ts");
const { compileFilter } = await from("net/index.ts");
const model = await from("model/index.ts");
const { frameDetail } = await from("ui/capture/frame-detail-model.ts");
const { defaultChoice, formView } = await from("ui/spawn-form/form.ts");
const frames = await import(join(root, "test/support/frames.ts"));

/** Ports are numbers before there are named switches, and belong to one after. */
const named = "samePort" in model;
const portOn = (port) => (named ? { switch: "switch0", port } : port);
const selected = (select, state) => (named ? select("switch0")(state) : select(state));

const print = (title, value) => console.log(`== ${title}\n${JSON.stringify(value, null, 1)}`);
const signal = new AbortController().signal;

function ports(state) {
	return { ports: selected(model.selectPorts, state), links: selected(model.selectLinks, state) };
}

async function ran(lab, line) {
	const parsed = lab.parse(line);
	if (isLineError(parsed)) return parsed;
	const state = lab.store.state;
	const said = {
		line: parsed.line,
		assumed: parsed.assumed,
		preview: parsed.preview(state),
		refused: parsed.validate(state),
		confirm: parsed.danger ? parsed.confirm(state) : null,
	};
	if (said.refused || parsed.danger) return said;
	const result = await Promise.race([
		parsed.run({ source: "bar", signal }).catch((error) => ({ error: error.message })),
		new Promise((done) => setTimeout(() => done("waits"), 20)),
	]);
	return { ...said, result };
}

const lab = storeLab();
print("help", await ran(lab, "help"));
for (const verb of VERBS) {
	print(`help ${verb.name}`, await ran(lab, `help ${verb.name}`));
	print(`manual ${verb.name}`, verb.manual);
}
const capture = createCaptureLog({ schedule: (fn) => fn(), now: () => 1500 });
const reads = { screens: { get: () => undefined }, capture };
for (const { prepare: _, ...tool } of toolTable(lab.registry, reads)) print(`tool ${tool.name}`, tool);

const COMPLETED = [
	"spawn 1 alpine --net ",
	"spawn 1 alpine --nics 2 --net switch0,",
	"spawn 1 alpine --",
	"link up ",
	"link down node1:",
	"rm ",
	"capture port:",
];
const LINES = [
	"spawn 2 alpine",
	"spawn 1 alpine --nics 3 --net switch0,none,switch0",
	"spawn 1 alpine --nics 2 --net none,switch0 --addr none,10.9.0.1/24 --name switch1",
	"spawn 1 alpine --name switch0",
	"spawn 1 alpine --name switch1",
	"spawn 1 alpine --net switch1",
	"spawn 1 alpine --net lan",
	"spawn 1 alpine --net switch0,none",
	"spawn 1 alpine --nics 2 --net switch0,switc0",
	"spawn 1 alpine --nics 4",
	"spawn 1 alpine --no-net --net switch0",
	"spawn 1 alpine --no-net",
	"spawn 1 alpine --nics 2 --no-gateway",
	"spawn 8 alpine",
	"spawn 2 alpine --nics 2",
	"ls",
	"link down node1",
	"link down node3:eth2,node1",
	"link up node1,node3",
	"link up node3:eth1",
	"link up node6",
	"link up node3",
	"link down all",
	"link up all",
	"link down switch0",
	"ls",
	"capture port:2",
	"capture port:9",
	"capture switch0",
	"focus node3",
	"sh node1",
	"rm node1",
	"rm node3",
	"rm all",
	"poweroff node1",
	"boot node1",
	"reboot node3",
	"checkpoint node3 before",
	"restore node3 before",
	"ls",
];
const settle = (l) => {
	for (const name of l.store.state.rail) {
		const { life } = l.store.state.machines[name];
		if (life.phase === "booting") l.runtime({ type: "vm/ready", machine: name, attempt: life.attempt, bootMs: 10 });
	}
};
for (const line of COMPLETED) print(`complete ${line}`, completeLine(lab.registry, line, line.length, lab.store.state));
for (const line of LINES) {
	print(`run ${line}`, await ran(lab, line));
	print(`booting after ${line}`, ports(lab.store.state));
	const choice = defaultChoice(lab.store.state);
	const commands = { registry: lab.registry, parse: lab.parse };
	for (const net of ["switch0", "none"]) {
		print(`form on ${net} after ${line}`, formView({ ...choice, net }, lab.store.state, commands));
	}
	settle(lab);
	const { state } = lab.store;
	print(`after ${line}`, {
		...ports(state),
		rail: model.selectRail(state),
		status: model.selectStatus(state),
		rows: state.rail.map((name) => {
			const focused = { ...state, keyboard: { kind: "pane", machine: name } };
			const details = model.selectDetails(focused);
			return [details.rows, details.cables, details.reason];
		}),
	});
}
for (const line of COMPLETED) print(`complete ${line}`, completeLine(lab.registry, line, line.length, lab.store.state));

/** The lab's failures free its ports, and a boot takes them again. */
lab.runtime({ type: "vm/failed", machine: "node3", attempt: lab.store.state.machines.node3.life.attempt, reason: "Broke." });
for (const line of ["boot node3", "ls", "rm node3"]) print(`failed ${line}`, await ran(lab, line));

const { arpReply, arpRequest, ping } = frames;
const taps = [
	[1, 0b110, "group", arpRequest(1, 2)],
	[2, 0b001, null, arpReply(2, 1)],
	[1, 0b010, null, ping(1, 2)],
	[1, 0b100, "unknown", ping(1, 5)],
	[3, 0, null, ping(3, 1)],
	[3, 0, "group", arpRequest(3, 1)],
];
for (const [port, to, flood, frame] of taps) capture.appendFrame({ switch: "switch0", from: port, to, flood, frame });
for (const up of [false, true]) {
	capture.appendLink({ port: portOn(2), machine: "node2", nic: 0, up, cause: up ? "agent" : "power" });
}
capture.sweep(5000);
print("rows", capture.tail(20));
print("counters", formatCounters(capture.counters));
for (const filter of ["port:1", "port:2", "port:3 arp", "node2", "arp or port:2", "port:8"]) {
	const compiled = compileFilter(filter, model.selectNames(lab.store.state));
	capture.setFilter(compiled.filter);
	print(`filter ${filter}`, capture.tail(20).map((row) => row.seq));
}
const tool = toolTable(lab.registry, reads).find(({ name }) => name === "capture_read");
for (const input of [{}, { filter: "port:2", limit: 2 }, { filter: "port:9" }]) {
	const prepared = tool.prepare(input, lab.store.state);
	print(`capture_read ${JSON.stringify(input)}`, prepared.ok ? await prepared.run(signal) : prepared);
}
for (const entry of capture.frames()) {
	const holder = (ref) => {
		const machine = selected(model.selectPorts, lab.store.state)[(named ? ref.port : ref) - 1].machine;
		return machine && { n: machine.n, label: machine.label };
	};
	print(`frame ${entry.seq}`, frameDetail(entry, { holder, severalNics: () => false }));
}

const labs = resolve(import.meta.dirname, "../../test/fixtures/saved-labs");
for (const file of readdirSync(labs)) {
	const base = model.initialState([{ name: "alpine", label: "alpine 3.24" }], { width: 1300, height: 500 });
	const restored = model.restoreWorkspace(base, readFileSync(join(labs, file), "utf8"));
	const store = model.createStore(restored.state, () => {});
	const registry = createRegistry(
		{ state: () => store.state, dispatch: (e) => store.dispatchCommand(e), until: store.until, now: () => 0 },
		VERBS,
	);
	const list = async (when) => {
		const { blocks, data } = await parseLine(registry, "ls", store.state).run({ source: "bar", signal });
		print(`${file} ${when}`, { blocks, data, ...ports(store.state), panes: store.state.panes });
	};
	await list("as it opens");
	for (const machine of store.state.rail) store.dispatchRuntime({ type: "vm/ready", machine, attempt: 1, bootMs: 10 });
	await list("ready");
	print(`${file} effects`, restored.effects.map((e) => ("port" in e ? { ...e, port: named ? e.port.port : e.port } : e)));
}
