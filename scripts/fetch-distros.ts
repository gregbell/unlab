// Mirror the distro images unkernel.dev serves, byte for byte.
//
// The images live as assets on the GitHub release that matches the installed
// unkernel package's version, indexed by distros.json with a size and a
// SHA-256 for each. That release is what unkernel.dev builds its own
// /distros/<name>-<hash>.erofs from, so pinning the package pins the images:
// nothing here is rebuilt or repacked, only downloaded and checked.

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const RELEASE_REPO = "pithings/unkernel";
const ROOT = new URL("../", import.meta.url);
const OUT = new URL("public/distros/", ROOT);

interface IndexEntry {
	name: string;
	file: string;
	size: number;
	sha256: string;
	/** The upstream build id, e.g. alpine-3.24.4-0efe379209f9a99a. */
	image: string;
}

interface Index {
	abi: number;
	base: string;
	distros: IndexEntry[];
}

async function sha256(path: URL): Promise<string> {
	const h = createHash("sha256");
	h.update(await readFile(path));
	return h.digest("hex");
}

async function main(): Promise<void> {
	const wanted = new Set(process.argv.slice(2).filter((a) => !a.startsWith("-")));
	const pkg = JSON.parse(await readFile(new URL("node_modules/unkernel/package.json", ROOT), "utf8")) as { version: string };
	const base = `https://github.com/${RELEASE_REPO}/releases/download/v${pkg.version}/`;
	console.log(`unkernel ${pkg.version}`);
	console.log(`release  ${base}`);

	const indexRes = await fetch(new URL("distros.json", base));
	if (!indexRes.ok) throw new Error(`distros.json: HTTP ${indexRes.status}`);
	const index = (await indexRes.json()) as Index;

	await mkdir(OUT, { recursive: true });
	const picked = index.distros.filter((d) => wanted.size === 0 || wanted.has(d.name));
	if (!picked.length) throw new Error(`no such distro: ${[...wanted].join(", ")} (have ${index.distros.map((d) => d.name).join(", ")})`);

	for (const d of picked) {
		const out = new URL(d.file, OUT);
		const have = await stat(out).catch(() => null);
		if (have?.size === d.size && (await sha256(out)) === d.sha256) {
			console.log(`  ${d.name.padEnd(7)} already mirrored (${d.image})`);
			continue;
		}
		const url = new URL(d.file, base);
		process.stdout.write(`  ${d.name.padEnd(7)} downloading ${(d.size / 1e6).toFixed(1)} MB ... `);
		const res = await fetch(url);
		if (!res.ok) throw new Error(`${d.file}: HTTP ${res.status}`);
		const bytes = new Uint8Array(await res.arrayBuffer());
		if (bytes.length !== d.size) throw new Error(`${d.file}: got ${bytes.length} bytes, distros.json says ${d.size}`);
		const sum = createHash("sha256").update(bytes).digest("hex");
		if (sum !== d.sha256) throw new Error(`${d.file}: SHA-256 ${sum}, distros.json says ${d.sha256}`);
		// Written through a temporary name: a half-written image must never be
		// left behind for the dev server to hand out.
		const tmp = new URL(`${d.file}.part`, OUT);
		await writeFile(tmp, bytes);
		await rename(fileURLToPath(tmp), fileURLToPath(out));
		console.log(`ok (${d.image})`);
	}

	// The manifest lists every image actually mirrored, not just the ones this
	// run asked for: fetching one distro must not un-list the others.
	const present: IndexEntry[] = [];
	for (const d of index.distros) {
		const f = await stat(new URL(d.file, OUT)).catch(() => null);
		if (f?.size === d.size) present.push(d);
	}
	const manifest = {
		unkernel: pkg.version,
		release: base,
		abi: index.abi,
		base: index.base,
		distros: present.map((d) => ({ name: d.name, file: d.file, size: d.size, sha256: d.sha256, image: d.image })),
	};
	await writeFile(new URL("distros.json", OUT), `${JSON.stringify(manifest, null, 2)}\n`);
	console.log(`wrote public/distros/distros.json (${present.map((d) => d.name).join(", ")})`);
}

await main();
