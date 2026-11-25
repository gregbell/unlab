import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
const here = fileURLToPath(new URL(".", import.meta.url));
const headers = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" };
export default defineConfig({
	root: here,
	publicDir: `${here}../../../public`,
	worker: { format: "es" },
	preview: { headers },
	build: { target: "esnext", minify: !process.env.SPIKE_PROFILE, outDir: process.env.SPIKE_OUT, emptyOutDir: true, rollupOptions: { input: [`${here}lab.html`, `${here}clock.html`, `${here}bench.html`] } },
});
