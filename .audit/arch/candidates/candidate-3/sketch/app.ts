// src/main.ts — the composition root, and scripts/check-imports.ts's matrix.
// main.ts is the only file that imports from every layer; it wires, it never decides.

import { createAgent, detectModelContext } from "./agent.ts";
import { createCaptureLog, selectCaptureConfig } from "./capture.ts";
import { createRegistry } from "./commands.ts";
import { createStore, initialState, type Effect } from "./model.ts";
import { createEngine, createScreens, startVm, type Engine, type LabSwitchApi } from "./runtime.ts";
import { appContext, defineElements, type AppServices } from "./ui.ts";

export async function main(root: HTMLElement): Promise<void> {
	const manifest = (await (await fetch("distros/manifest.json")).json()) as { distros: { name: string }[] };
	const t0 = performance.now();
	const now = () => performance.now() - t0;

	// The engine needs dispatch, the store needs the engine's run: a late-bound effect sink, set once below.
	let engine!: Engine;
	const store = createStore(
		initialState(manifest.distros.map((d) => d.name), { width: innerWidth, height: innerHeight }),
		(e: Effect) => engine.run(e),
	);

	const capture = createCaptureLog(
		{ maxEntries: 10_000, maxBytes: 16 << 20 },
		() => selectCaptureConfig(store.state),
		{ live: (name) => store.state.machines[name] !== undefined },
		requestAnimationFrame,
	);
	const screens = createScreens(document.querySelector<HTMLElement>("#garage")!);
	const sw = undefined as unknown as LabSwitchApi; // new LabSwitch()
	engine = createEngine({
		dispatch: store.dispatchRuntime,
		capture,
		screens,
		sw,
		image: (name) => {
			throw new Error(`not implemented: loadImage for ${name}`);
		},
		startVm,
		announce: (text) => {
			throw new Error(`not implemented: announcer ${text}`);
		},
		setClock: (hz) => {
			throw new Error(`not implemented: ticker at ${hz} Hz dispatching tick{now} and capture.sweep(now)`);
		},
	});

	const commands = createRegistry({ store, exec: engine, now });
	const agent = createAgent({
		store,
		registry: commands,
		exec: engine,
		capture,
		modelContext: detectModelContext(document, navigator),
		now,
	});

	const services: AppServices = {
		store,
		commands,
		ui: store.dispatchUi,
		capture,
		reads: engine.reads,
		screens,
		agent: agent.controls,
		confirmInBar: () => {
			throw new Error("not implemented");
		},
	};
	defineElements();
	const app = document.createElement("unlab-app");
	// <unlab-app> is the ContextProvider for appContext.
	(app as unknown as { services: AppServices }).services = services;
	root.append(app);
	void appContext;
}

// ───────────────────────────── scripts/check-imports.ts: the layering, as data ─────────────────────────────

/**
 * Each src/ directory may import only the directories listed, and only
 * through their index.ts (a deep import across directories fails the check).
 * `import type` is held to the same rule. Runs in `npm run check`; ~80 lines,
 * a regex over import specifiers (no TS API needed), with its own unit test.
 */
export const LAYERS = {
	net: [],
	model: ["net"],
	capture: ["net", "model"],
	commands: ["net", "model"],
	runtime: ["net", "model", "capture", "commands"], // commands: ExecPort/InjectOutcome types only
	agent: ["model", "capture", "commands"],
	ui: ["net", "model", "commands", "services"], // never runtime, capture impl or agent impl: only services.ts interfaces
	services: ["model", "commands", "capture", "runtime"], // types only (enforced: every import in services.ts is `import type`)
	workers: ["net", "runtime/worker-side"], // vm-worker.ts: nic, image, guest, protocol
	main: ["*"],
} as const;

/** Files only some layers may import, despite the directory rule. */
export const RESTRICTED = {
	// Not re-exported by commands/index.ts. The bar's second Enter and an agent
	// answer (or standing `run` policy) are the only two places a yes is minted.
	"commands/approval.ts": ["ui/command-bar", "agent"],
} as const;
