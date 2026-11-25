// The composition root: the one module that sees every layer. It builds the
// store, the runtime and the command service, binds them, and mounts the app.
import "@wterm/dom/css";
import "./ui/styles/index.css";
import "./ui/app/app.ts";

import { detectModelContext, startAgent } from "./agent/index.ts";
import { createCaptureLog } from "./capture/index.ts";
import { createCommandService, createRegistry, VERBS } from "./commands/index.ts";
import {
	clockHz,
	createStore,
	type Effect,
	type ImageInfo,
	initialState,
	machineList,
	restoreWorkspace,
	type Store,
	saveWorkspace,
	selectNames,
	severalNics,
} from "./model/index.ts";
import { compileFilter } from "./net/index.ts";
import { createRuntime, type DistroManifest, type Engine, sweepDisks } from "./runtime/index.ts";
import type { AppServices, TerminalHost } from "./ui/services.ts";

interface Manifest extends DistroManifest {
	readonly distros: readonly {
		readonly name: string;
		readonly file: string;
		readonly size: number;
		readonly image: string;
	}[];
}

/** `alpine-3.24.4-0efe…` reads `alpine 3.24`. */
function imageLabel(name: string, image: string): string {
	const version = /^[a-z]+-(\d+(?:\.\d+)?)/.exec(image)?.[1];
	return version ? `${name} ${version}` : name;
}

/**
 * Once per animation frame, or on the next task while the tab is hidden:
 * requestAnimationFrame stops in a background tab, and an agent driving the
 * lab from elsewhere must still see its calls settle.
 */
function frameScheduler(): (fn: () => void) => void {
	const channel = new MessageChannel();
	const queued: (() => void)[] = [];
	channel.port1.onmessage = () => {
		for (const fn of queued.splice(0)) fn();
	};
	return (fn) => {
		if (document.hidden) {
			queued.push(fn);
			channel.port2.postMessage(null);
		} else {
			requestAnimationFrame(fn);
		}
	};
}

/** What acts on a guest or its disks. The lab must come back from a reload knowing that it had been asked. */
const RECORDED: ReadonlySet<Effect["type"]> = new Set<Effect["type"]>([
	"vm/boot",
	"vm/stop",
	"checkpoint/save",
	"checkpoint/restore",
	"disks/delete",
]);

async function loadManifest(): Promise<Manifest> {
	const res = await fetch("distros/distros.json");
	if (!res.ok) throw new Error("No mirrored images. Run: npm run distros alpine");
	return (await res.json()) as Manifest;
}

async function main(): Promise<void> {
	const manifest = await loadManifest();
	const images: ImageInfo[] = manifest.distros.map((d) => ({ name: d.name, label: imageLabel(d.name, d.image) }));
	const started = performance.now();
	const now = () => performance.now() - started;
	const schedule = frameScheduler();

	const app = document.createElement("unlab-app");
	const capture = createCaptureLog({
		schedule,
		now,
		names: () => selectNames(store.state),
		severalNics: (machine) => severalNics(store.state, machine),
	});
	let runtime: Engine | undefined;
	const key = "unlab.workspace.v1";
	const restored = restoreWorkspace(
		initialState(images, { width: window.innerWidth - 232, height: window.innerHeight - 300 }),
		localStorage.getItem(key),
	);
	const kept = new Map(machineList(restored.state).map(({ n, sets }) => [n, sets]));
	await sweepDisks((n, set) => {
		const sets = kept.get(n);
		if (!sets) return n < restored.state.nextN;
		return set < sets.next && set !== sets.live && sets.checkpoints.every((checkpoint) => checkpoint.set !== set);
	});
	const store: Store = createStore(
		restored.state,
		(effect: Effect) => {
			// Before anything is done that a reload could cut short.
			if (RECORDED.has(effect.type)) save();
			runtime?.run(effect);
		},
		schedule,
	);
	let saved = localStorage.getItem(key);
	const save = () => {
		const next = saveWorkspace(store.state);
		if (next !== saved) {
			localStorage.setItem(key, next);
			saved = next;
		}
	};
	store.subscribe(save);
	runtime = createRuntime({
		store,
		capture,
		manifest,
		announce: (text) => app.announce(text),
		now,
	});
	save();
	for (const effect of restored.effects) runtime.run(effect);
	// The model asks for a faster clock while machines boot; at rest it still needs one, or its idea of now never moves.
	runtime.run({ type: "clock", hz: clockHz(store.state) });

	let filter = store.state.capture.filter;
	let filtered = true;
	let names = selectNames(store.state);
	let paused = store.state.capture.paused;
	store.subscribe(() => {
		const next = store.state.capture;
		const known = selectNames(store.state);
		// A word that named no machine when it was typed can name one later.
		if (next.filter !== filter || (!filtered && known !== names)) {
			filter = next.filter;
			const compiled = compileFilter(filter, known);
			filtered = compiled.ok;
			if (compiled.ok) capture.setFilter(compiled.filter);
		}
		names = known;
		if (next.paused !== paused) {
			paused = next.paused;
			capture.setPaused(paused);
		}
	});

	const engine = runtime;
	const registry = createRegistry(
		{
			state: () => store.state,
			dispatch: (event) => store.dispatchCommand(event),
			until: (predicate, signal) => store.until(predicate, signal),
			now,
			exec: engine.exec,
			files: engine.files,
		},
		VERBS,
	);
	const commands = createCommandService({
		registry,
		store,
		openBar: (line) => app.dispatchEvent(new CustomEvent("unlab-open-bar", { detail: line })),
	});

	const agent = startAgent({
		store,
		registry,
		screens: engine.screens,
		capture,
		modelContext: detectModelContext(document, navigator),
	});

	const services: AppServices = {
		store,
		commands,
		capture,
		switch: { ...engine.reads, now },
		terminals: {
			host(session): TerminalHost | null {
				const screen = engine.screens.get(session);
				if (!screen) return null;
				return {
					mount: (element) => void screen.mount(element),
					setVisible: (visible) => screen.setVisible(visible),
					setFocused: (focused) => screen.setFocused(focused),
					focus: () => screen.setFocused(true),
					marks: () => screen.marks(),
					onRender: (listener) => screen.subscribe(listener),
				};
			},
		},
		agent,
	};
	app.services = services;
	document.body.append(app);
	window.addEventListener("pagehide", () => {
		save();
		agent.dispose();
		engine.dispose();
	});
}

async function openWorkspace(): Promise<void> {
	// Reload once under the scoped worker on static hosts without COOP/COEP.
	if (
		import.meta.env.PROD &&
		!crossOriginIsolated &&
		"serviceWorker" in navigator &&
		!navigator.serviceWorker.controller
	) {
		try {
			await navigator.serviceWorker.register("./isolation.js");
			await navigator.serviceWorker.ready;
			location.reload();
			return;
		} catch (error) {
			console.warn("Cross-origin isolation unavailable.", error);
		}
	}
	await navigator.locks.request("unlab.workspace.v1", { ifAvailable: true }, async (lock) => {
		if (!lock) throw new Error("This lab is open in another tab. Close that tab and reload to open it here.");
		await main();
		await new Promise<void>((resolve) => window.addEventListener("pagehide", () => resolve(), { once: true }));
	});
}
window.addEventListener("pageshow", (event) => {
	if (event.persisted) location.reload();
});
void openWorkspace().catch((error: unknown) => {
	const message = error instanceof Error ? error.message : String(error);
	document.body.textContent = message;
	console.error(error);
});
