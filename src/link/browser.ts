// What the link needs of a browser.

import { FORGOTTEN, type LinkDeps, type LinkMemory, type LinkSocket } from "./link.ts";

const KEY = "unlab.cli.v1";

function read(): LinkMemory {
	try {
		const saved = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<LinkMemory> | null;
		if (typeof saved?.on !== "boolean" || !Number.isInteger(saved.port)) return FORGOTTEN;
		return { on: saved.on, port: saved.port as number };
	} catch {
		return FORGOTTEN;
	}
}

/** Browsers split the one permission into two, and the first of these names is the narrower. */
const PERMISSIONS = ["loopback-network", "local-network-access"] as const;

async function permission(): Promise<PermissionState | null> {
	for (const name of PERMISSIONS) {
		try {
			return (await navigator.permissions.query({ name: name as PermissionName })).state;
		} catch {
			// This browser does not know the name.
		}
	}
	return null;
}

export const browserDeps: Pick<LinkDeps, "dial" | "memory" | "everySecond" | "permission"> = {
	dial: (url) => new WebSocket(url) as LinkSocket,
	memory: {
		read,
		write: (memory) => localStorage.setItem(KEY, JSON.stringify(memory)),
	},
	everySecond(fn) {
		const worker = new Worker(new URL("./clock-worker.ts", import.meta.url), { type: "module", name: "unlab-link" });
		worker.addEventListener("message", fn);
		return () => worker.terminate();
	},
	permission,
};
