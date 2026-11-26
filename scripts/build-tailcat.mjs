import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = fileURLToPath(new URL("../", import.meta.url));
const cwd = resolve(root, "tailcat");
const go = process.env.GO ?? "go";
const env = { ...process.env, GOTOOLCHAIN: "go1.27.4" };
const run = (args, options = {}) => execFileSync(go, args, { cwd, env, stdio: "inherit", ...options });
const version = run(["version"], { encoding: "utf8", stdio: "pipe" });
if (!version.startsWith("go version go1.27.4 ")) throw new Error("Tailcat requires Go 1.27.4.");
const output = resolve(root, "public/tailcat");
mkdirSync(output, { recursive: true });
const tags = run(["run", "./tags"], { encoding: "utf8", stdio: "pipe" }).trim();
run(
	[
		"build",
		"-mod=readonly",
		"-trimpath",
		"-buildvcs=false",
		`-tags=${tags}`,
		"-ldflags=-s -w",
		"-o",
		resolve(output, "tailcat.wasm"),
		".",
	],
	{
		env: { ...env, GOOS: "js", GOARCH: "wasm", CGO_ENABLED: "0" },
	},
);
const goroot = run(["env", "GOROOT"], { encoding: "utf8", stdio: "pipe" }).trim();
copyFileSync(resolve(goroot, "lib/wasm/wasm_exec.js"), resolve(output, "wasm_exec.js"));

const wasm = resolve(output, "tailcat.wasm");
writeFileSync(`${wasm}.gz`, gzipSync(readFileSync(wasm), { level: 9 }));
unlinkSync(wasm);

const dependencies = run(
	[
		"list",
		"-mod=readonly",
		`-tags=${tags}`,
		"-deps",
		"-f",
		"{{if .Module}}{{.Module.Path}}|{{.Module.Dir}}|{{.Dir}}{{else}}Go|{{.Root}}|{{.Dir}}{{end}}",
		".",
	],
	{
		encoding: "utf8",
		stdio: "pipe",
		env: { ...env, GOOS: "js", GOARCH: "wasm", CGO_ENABLED: "0" },
	},
)
	.trim()
	.split("\n");
const notices = new Map([["Go/LICENSE", readFileSync(resolve(goroot, "LICENSE"), "utf8")]]);
for (const line of dependencies) {
	const [module, listedRoot, packageDir] = line.split("|");
	const moduleDir = module === "Go" ? goroot : listedRoot;
	if (!moduleDir || module === "unlab/tailcat") continue;
	for (let dir = packageDir; ; dir = dirname(dir)) {
		for (const name of readdirSync(dir)) {
			if (/^(licen[cs]e|copying|notice)([.-].*)?$/i.test(name)) {
				const file = resolve(dir, name);
				notices.set(`${module}/${relative(moduleDir, file)}`, readFileSync(file, "utf8"));
			}
		}
		if (dir === moduleDir) break;
		if (dirname(dir) === dir) throw new Error(`Dependency ${module} is outside its module directory.`);
	}
}
writeFileSync(
	resolve(output, "licenses.txt"),
	Array.from(notices)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([name, text]) => `${name}\n${text}`)
		.join("\n\n"),
);
