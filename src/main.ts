// The composition root: the one module that sees every layer. It builds the
// store, the runtime and the command service, binds them, and mounts the app.
import "@wterm/dom/css";
import "./ui/styles/index.css";
import "./ui/app/app.ts";

import { createCaptureLog } from "./capture/index.ts";
import { createCommandService, createRegistry, VERBS } from "./commands/index.ts";
import { createStore, type Effect, type ImageInfo, initialState, type Store } from "./model/index.ts";
import { compileFilter } from "./net/index.ts";
import { createRuntime, type DistroManifest, type Engine } from "./runtime/index.ts";
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
	const capture = createCaptureLog({ schedule, now });
	let runtime: Engine | undefined;
	const store: Store = createStore(
		initialState(images, { width: window.innerWidth - 232, height: window.innerHeight - 300 }),
		(effect: Effect) => runtime?.run(effect),
		schedule,
	);
	runtime = createRuntime({ store, capture, manifest, announce: (text) => app.announce(text), now });

	let filter = store.state.capture.filter;
	let paused = store.state.capture.paused;
	store.subscribe(() => {
		const next = store.state.capture;
		if (next.filter !== filter) {
			filter = next.filter;
			const compiled = compileFilter(filter);
			if (compiled.ok) capture.setFilter(compiled.filter);
		}
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
			now: () => store.state.now,
			exec: engine.exec,
		},
		VERBS,
	);
	const commands = createCommandService({
		registry,
		store,
		openBar: (line) => app.dispatchEvent(new CustomEvent("unlab-open-bar", { detail: line })),
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
	};
	app.services = services;
	document.body.append(app);
	window.addEventListener("pagehide", () => engine.dispose());

	// Until the empty-lab view and the Add machines form land, a new lab boots two machines.
	void commands.run("spawn 2 alpine", "button");
}

void main().catch((error: unknown) => {
	const message = error instanceof Error ? error.message : String(error);
	document.body.textContent = message;
	console.error(error);
});
