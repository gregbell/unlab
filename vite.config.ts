import { defineConfig } from "vite";

/**
 * Cross-origin isolation. A single-CPU machine does not need it, but it is
 * what would let a kernel built with CONFIG_SMP start its other CPUs on
 * shared memory, and every asset here is same-origin, so it costs nothing.
 */
const COI_HEADERS = {
	"Cross-Origin-Opener-Policy": "same-origin",
	"Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
	// Each machine runs in its own ES module worker.
	worker: { format: "es" },
	// unkernel locates its kernel with new URL("unkernel.wasm", import.meta.url).
	// Pre-bundling rewrites that and the kernel goes missing, so leave it alone.
	optimizeDeps: { exclude: ["unkernel"] },
	server: { headers: COI_HEADERS },
	preview: { headers: COI_HEADERS },
	build: { target: "esnext" },
});
