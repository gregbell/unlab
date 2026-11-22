import type { MachineName, Panes } from "./types.ts";

export interface Tile {
	readonly machine: MachineName;
	/** A `grid-area` value: row start / column start / row end / column end. */
	readonly area: string;
}

/** Placement of the visible panes on one CSS grid. */
export interface Tiling {
	/** `grid-template-columns`. */
	readonly columns: string;
	/** `grid-template-rows`. */
	readonly rows: string;
	readonly tiles: readonly Tile[];
}

// minmax(0, …) and not a bare fr, because a terminal's content must not widen its track.
const tracks = (weights: readonly number[]): string => weights.map((w) => `minmax(0, ${w}fr)`).join(" ");
const even = (count: number): string => tracks(Array.from({ length: count }, () => 1));

/**
 * The handoff's tiling table. Three panes with two rows to use are a main
 * pane and a stack. Every other count is balanced rows filled left to right,
 * then down.
 */
export function tile(visible: readonly MachineName[], grid: Panes["grid"]): Tiling {
	if (visible.length === 0) return { columns: even(1), rows: even(1), tiles: [] };
	if (visible.length === 3 && grid.rows === 2 && grid.cols >= 2) return mainAndStack(visible, grid.cols);
	return balancedRows(visible, grid.cols);
}

function mainAndStack(visible: readonly MachineName[], cols: number): Tiling {
	const [main, upper, lower] = visible;
	return {
		// 3:2 lines the divider up with the dock's. Two columns means the area is
		// under 1200px, where 2/5 of it would be narrower than a pane may be.
		columns: tracks(cols === 3 ? [3, 2] : [1, 1]),
		rows: even(2),
		tiles: [
			{ machine: main, area: "1 / 1 / 3 / 2" },
			{ machine: upper, area: "1 / 2 / 2 / 3" },
			{ machine: lower, area: "2 / 2 / 3 / 3" },
		],
	};
}

function balancedRows(visible: readonly MachineName[], cols: number): Tiling {
	const rowCount = Math.ceil(visible.length / cols);
	const perRow = Math.ceil(visible.length / rowCount);
	const lastRow = visible.length - perRow * (rowCount - 1);
	// A row of three and a row of two share one grid of six tracks.
	const trackCount = lcm(perRow, lastRow);
	const tiles = visible.map((machine, i): Tile => {
		const row = Math.floor(i / perRow);
		const span = trackCount / (row === rowCount - 1 ? lastRow : perRow);
		const start = (i % perRow) * span;
		return { machine, area: `${row + 1} / ${start + 1} / ${row + 2} / ${start + span + 1}` };
	});
	return { columns: even(trackCount), rows: even(rowCount), tiles };
}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
const lcm = (a: number, b: number): number => (a * b) / gcd(a, b);
