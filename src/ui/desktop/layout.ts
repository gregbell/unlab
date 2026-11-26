import {
	type LabState,
	type MachineName,
	parseMachineName,
	parseSessionId,
	parseSwitchName,
	type SwitchName,
} from "../../model/index.ts";

export interface Point {
	x: number;
	y: number;
}
export interface Box extends Point {
	w: number;
	h: number;
}
type Content =
	| { kind: "console"; session: string }
	| { kind: "capture"; on: string }
	| { kind: "switch-details"; name: SwitchName }
	| { kind: "note"; text: string }
	| { kind: "config"; name: MachineName; machineNumber: number }
	| { kind: "rack" | "topology" };
export type Item = Box &
	Content & { id: string; z: number; resumeMax?: boolean; state: "open" | "mini" | "max" | "closed" };
export interface Layout {
	items: Item[];
}
export function item(content: Content, box: Box, z: number): Item {
	return { ...content, ...box, z, state: "open", id: crypto.randomUUID() };
}
function record(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}
function point(v: unknown): v is Point {
	return record(v) && Number.isFinite(v.x) && Number.isFinite(v.y);
}
function validItem(v: unknown): v is Item {
	if (
		!record(v) ||
		!point(v) ||
		typeof v.id !== "string" ||
		!Number.isFinite(v.z) ||
		typeof v.w !== "number" ||
		!Number.isFinite(v.w) ||
		v.w <= 0 ||
		typeof v.h !== "number" ||
		!Number.isFinite(v.h) ||
		v.h <= 0 ||
		!["open", "mini", "max", "closed"].includes(String(v.state))
	)
		return false;
	return (
		v.kind === "rack" ||
		v.kind === "topology" ||
		(v.kind === "switch-details" && typeof v.name === "string" && typeof parseSwitchName(v.name) === "string") ||
		(v.kind === "config" &&
			typeof v.name === "string" &&
			!!parseMachineName(v.name) &&
			Number.isSafeInteger(v.machineNumber)) ||
		(v.kind === "note" && typeof v.text === "string") ||
		(v.kind === "capture" && typeof v.on === "string") ||
		(v.kind === "console" && typeof v.session === "string" && !!parseSessionId(v.session))
	);
}
export function loadLayout(key: string, defaults: () => Layout): Layout {
	try {
		const v: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
		if (
			record(v) &&
			Array.isArray(v.items) &&
			v.items.every(validItem) &&
			v.items.filter((i) => i.kind === "rack").length === 1 &&
			new Set(v.items.map((i) => i.id)).size === v.items.length
		)
			return { items: v.items };
	} catch {}
	return defaults();
}
export function alignWithLab(layout: Layout, lab: LabState) {
	layout.items = layout.items.filter((i) =>
		i.kind === "switch-details"
			? lab.switches.includes(i.name)
			: i.kind === "config"
				? lab.machines[i.name]?.n === i.machineNumber
				: i.kind === "console"
					? lab.rail.some((name) => i.session.startsWith(`${name}:`))
					: i.kind === "capture"
						? lab.switches.some((on) => on === i.on)
						: true,
	);
}
export function resized(b: Box, dir: string, dx: number, dy: number): Box {
	const w = dir.includes("e") ? Math.max(240, b.w + dx) : dir.includes("w") ? Math.max(240, b.w - dx) : b.w;
	const h = dir.includes("s") ? Math.max(120, b.h + dy) : dir.includes("n") ? Math.max(120, b.h - dy) : b.h;
	return { w, h, x: dir.includes("w") ? b.x + b.w - w : b.x, y: dir.includes("n") ? b.y + b.h - h : b.y };
}

// Start with equipment above the terminals. All boxes become ordinary movable windows.
export function startupBoxes() {
	const width = innerWidth;
	const height = Math.max(300, innerHeight - 100);
	const narrow = width < 800;
	const gap = narrow ? 10 : 18;
	const left = narrow ? gap : Math.max(gap, (width - 1580) / 2);
	const usable = width - left * 2;
	const rackWidth = narrow ? usable : Math.round((usable - gap) * 0.42);
	const top = Math.min(440, Math.round((height - 3 * gap) * 0.55));
	const termWidth = narrow ? usable : (usable - gap) / 2;
	return {
		narrow,
		rack: { x: left, y: gap, w: rackWidth, h: top },
		topology: {
			x: narrow ? left : left + rackWidth + gap,
			y: gap,
			w: narrow ? usable : usable - gap - rackWidth,
			h: top,
		},
		terminal: (index: number) => ({
			x: left + (narrow ? 0 : index * (termWidth + gap)),
			y: top + 2 * gap,
			w: termWidth,
			h: Math.max(140, height - top - 3 * gap),
		}),
	};
}
export function firstDesktop() {
	const boxes = startupBoxes();
	const topology = item({ kind: "topology" }, boxes.topology, 1);
	if (boxes.narrow) topology.state = "closed";
	return { items: [item({ kind: "rack" }, boxes.rack, 2), topology] };
}
