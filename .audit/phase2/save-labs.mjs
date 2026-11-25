// Writes one saved lab for each version of the workspace before 7, with the code that wrote that version:
// the same lab as each version could hold it. A machine could be called switch1 from version 4 on.
//
//   node .audit/phase2/save-labs.mjs <empty dir for checkouts> test/fixtures/saved-labs

import { execFileSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const [checkouts, out] = process.argv.slice(2).map((path) => resolve(path));
const COMMITS = { 1: "5fb6f93", 2: "25759b5", 3: "582cb30", 4: "1243028", 5: "443b378", 6: "24c38d9" };

function checkout(commit) {
	const dir = join(checkouts, commit);
	mkdirSync(dir, { recursive: true });
	execFileSync("sh", ["-c", `git archive ${commit} src package.json | tar -x -C "${dir}"`]);
	symlinkSync(resolve("node_modules"), join(dir, "node_modules"));
	return dir;
}

async function savedLab(version, dir) {
	const from = (file) => import(join(dir, "src/model", file));
	const kit = await from("testkit.ts");
	const { planSpawn, isPlanError } = await from("machines.ts");
	const { saveWorkspace } = await from("workspace.ts");
	const { run, isReady, linkEvent, remove, hasStopped } = kit;
	let s = kit.emptyLab();

	/** A spawn as this version asked for one, with what it could not ask for left out. */
	const spawn = (count, { image = "alpine", nets = ["switch0"], addr, name, extra = [] } = {}) => {
		const hardware = {
			image,
			memMiB: 256,
			cpus: 1,
			...(version < 5 ? { diskGiB: "8" } : { disks: { root: "8", extra: extra.map(kit.gib) } }),
			...(version < 3 ? {} : { gateway: addr === undefined && nets[0] === "switch0" }),
			...(version < 4 || !name ? {} : { name: kit.named(name) }),
		};
		const address = (text, nic) => {
			if (addr === undefined) return nic === 0 ? "default" : null;
			return text === null ? null : kit.address(text);
		};
		const nics = nets.map((net, nic) => (version < 3 ? { net } : { net, address: address(addr?.[nic] ?? null, nic) }));
		const plan = planSpawn(s, count, version < 2 ? { ...hardware, net: nets[0] } : { ...hardware, nics });
		if (isPlanError(plan)) throw new Error(JSON.stringify(plan));
		s = run(s, { type: "cmd/spawn", plan, at: 0 }, ...plan.machines.map(({ identity }) => isReady(identity.name)));
		return plan.machines[0].identity.name;
	};

	spawn(3);
	s = run(s, remove("node2"), hasStopped("node2"));
	const second = spawn(1, { name: "switch1" });
	s = run(s, linkEvent(s, false, second));
	const router = { nets: ["switch0", "none", "switch0"], addr: ["10.1.0.1/24", null, "10.2.0.1/24"], extra: [1] };
	if (version >= 2) {
		const name = spawn(1, router);
		s = run(s, linkEvent(s, false, { machine: name, nic: 2 }));
	}
	spawn(1, { nets: ["none"] });
	s = run(s, { type: "ui/park", machine: "node3" }, { type: "ui/policy", tool: "link_set", policy: "ask" });
	if (version >= 5) s = run(s, kit.power("off", "node3"), hasStopped("node3"));
	if (version >= 6) s = run(s, kit.checkpoint("node1", "before"), kit.isSaved("node1", 1));
	return saveWorkspace(s);
}

mkdirSync(out, { recursive: true });
for (const [version, commit] of Object.entries(COMMITS)) {
	const saved = JSON.parse(await savedLab(Number(version), checkout(commit)));
	if (saved.version !== Number(version)) throw new Error(`${commit} saves version ${saved.version}`);
	writeFileSync(join(out, `version-${version}.json`), `${JSON.stringify(saved, null, "\t")}\n`);
	console.log(version, commit, saved.nodes.map((node) => node.name ?? `node${node.n}`).join(" "));
}
