import { without } from "./record.ts";
import type { Keyboard, MachineName, Panes, ParkReason } from "./types.ts";

export type Grid = Panes["grid"];

const MIN_PANE_WIDTH = 400;
const MIN_PANE_HEIGHT = 200;

/** As many columns and rows as fit without a pane going under its minimum size, three by two at most. */
export function gridFor(width: number, height: number): Grid {
	return {
		cols: width >= 3 * MIN_PANE_WIDTH ? 3 : width >= 2 * MIN_PANE_WIDTH ? 2 : 1,
		rows: height >= 2 * MIN_PANE_HEIGHT ? 2 : 1,
	};
}

export function emptyPanes(grid: Grid): Panes {
	return { order: [], parked: {}, focusStamp: {}, focusClock: 0, maximised: null, grid };
}

export const capacity = (p: Panes): number => (p.maximised ? 1 : p.grid.cols * p.grid.rows);

type Parking = Pick<Panes, "order" | "parked">;

export const visiblePanes = (p: Parking): readonly MachineName[] => p.order.filter((m) => p.parked[m] === undefined);

/** The parked strip's chips, in pane order. */
export const parkedPanes = (p: Parking): readonly MachineName[] => p.order.filter((m) => p.parked[m] !== undefined);

/** The machine whose pane has the keyboard, or gets it back when the command bar closes. */
export function keyboardHolder(keyboard: Keyboard): MachineName | null {
	if (keyboard.kind === "pane") return keyboard.machine;
	return keyboard.kind === "bar" ? keyboard.returnTo : null;
}

/** The pane focused most recently, parked or not. */
export function lastFocused(p: Panes, among: readonly MachineName[] = p.order): MachineName | null {
	let best: MachineName | null = null;
	let bestStamp = 0;
	for (const m of among) {
		const stamp = p.focusStamp[m] ?? 0;
		if (stamp > bestStamp) {
			best = m;
			bestStamp = stamp;
		}
	}
	return best;
}

/**
 * The two parking rules. Every pane function ends here. Over capacity, the
 * visible pane focused longest ago parks itself, never the maximised one. With
 * room to spare, automatically parked panes return, most recently focused
 * first. Panes parked by the user are left alone.
 */
export function reconcilePanes(p: Panes): Panes {
	const stamp = (m: MachineName): number => p.focusStamp[m] ?? 0;
	const visible = visiblePanes(p);
	const spare = capacity(p) - visible.length;
	if (spare === 0) return p;

	const parked = { ...p.parked };
	if (spare < 0) {
		// Among panes never focused, the later one parks first.
		const stalest = visible.filter((m) => m !== p.maximised?.machine).reverse();
		stalest.sort((a, b) => stamp(a) - stamp(b));
		for (const m of stalest.slice(0, -spare)) parked[m] = "auto";
	} else {
		const waiting = p.order.filter((m) => p.parked[m] === "auto");
		if (waiting.length === 0) return p;
		waiting.sort((a, b) => stamp(b) - stamp(a));
		for (const m of waiting.slice(0, spare)) delete parked[m];
	}
	return { ...p, parked };
}

/**
 * New panes go to the end of the order. They count as just focused, so it is
 * an older pane that parks for them. Two exceptions. The pane focused last
 * stays ahead of them, and within one batch the earlier machine wins.
 */
export function addPanes(p: Panes, machines: readonly MachineName[]): Panes {
	const fresh = [...new Set(machines)].filter((m) => !p.order.includes(m));
	if (fresh.length === 0) return p;
	const focusStamp = { ...p.focusStamp };
	let clock = p.focusClock;
	for (const m of fresh.toReversed()) focusStamp[m] = ++clock;
	const keep = lastFocused(p);
	if (keep) focusStamp[keep] = ++clock;
	return reconcilePanes({ ...p, order: [...p.order, ...fresh], focusStamp, focusClock: clock });
}

export function removePane(p: Panes, m: MachineName): Panes {
	if (!p.order.includes(m)) return p;
	const q = p.maximised?.machine === m ? unmaximised(p) : p;
	return reconcilePanes({
		...q,
		order: q.order.filter((other) => other !== m),
		parked: without(q.parked, m),
		focusStamp: without(q.focusStamp, m),
		maximised: q.maximised && { machine: q.maximised.machine, before: without(q.maximised.before, m) },
	});
}

/**
 * Stamps the focus and brings a parked pane back, which may park the stalest
 * other pane in exchange. Never reorders. Focusing a pane other than the
 * maximised one ends the maximise first.
 */
export function focusPane(p: Panes, m: MachineName): Panes {
	if (!p.order.includes(m)) return p;
	const q = p.maximised && p.maximised.machine !== m ? unmaximised(p) : p;
	const clock = q.focusClock + 1;
	const stamped = lastFocused(q) === m ? q : { ...q, focusStamp: { ...q.focusStamp, [m]: clock }, focusClock: clock };
	const back = stamped.parked[m] === undefined ? stamped : { ...stamped, parked: without(stamped.parked, m) };
	return reconcilePanes(back);
}

/** The park button. Parking by hand ends a maximise. */
export function parkPane(p: Panes, m: MachineName): Panes {
	if (!p.order.includes(m)) return p;
	const q = unmaximised(p);
	if (q.parked[m] === "user") return reconcilePanes(q);
	return reconcilePanes({ ...q, parked: { ...q.parked, [m]: "user" } });
}

/** `focus --main` moves the pane to the front of the order, which is the main slot of the three-pane layout. */
export function promotePane(p: Panes, m: MachineName): Panes {
	if (p.order[0] === m || !p.order.includes(m)) return p;
	return { ...p, order: [m, ...p.order.filter((other) => other !== m)] };
}

/** Maximise parks every other pane and remembers the parking. Maximise again restores it exactly. */
export function toggleMaximise(p: Panes, m: MachineName): Panes {
	if (!p.order.includes(m)) return p;
	const q = unmaximised(p);
	if (p.maximised?.machine === m) return reconcilePanes(q);
	const parked: Partial<Record<MachineName, ParkReason>> = {};
	for (const other of q.order) if (other !== m) parked[other] = "auto";
	return { ...q, parked, maximised: { machine: m, before: q.parked } };
}

export function resizeArea(p: Panes, width: number, height: number): Panes {
	const grid = gridFor(width, height);
	if (grid.cols === p.grid.cols && grid.rows === p.grid.rows) return p;
	return reconcilePanes({ ...p, grid });
}

/** The parking from before the maximise. Machines added since are in no map, so they come back visible. */
function unmaximised(p: Panes): Panes {
	return p.maximised ? { ...p, parked: p.maximised.before, maximised: null } : p;
}
