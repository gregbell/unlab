import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const { version } = JSON.parse(readFileSync(here("package.json"), "utf8")) as { version: string };

// One file with everything in it: npx installs nothing else, and the copy that ssh runs needs nothing beside it.
export default defineConfig({
	publicDir: false,
	define: { UNLAB_VERSION: JSON.stringify(version) },
	ssr: { noExternal: true },
	build: {
		ssr: here("src/main.ts"),
		outDir: here("dist"),
		emptyOutDir: true,
		target: "node22",
		minify: false,
		rolldownOptions: {
			// Speeds up ws where it is installed, which it never is here.
			external: ["bufferutil", "utf-8-validate"],
			output: { entryFileNames: "cli.mjs" },
		},
	},
});
