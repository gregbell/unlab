import { describe, expect, test } from "vitest";
import { type Tiling, tile } from "./tiling.ts";
import type { MachineName, Panes } from "./types.ts";

type Grid = Panes["grid"];

interface Rect {
	readonly x: number;
	readonly y: number;
	readonly w: number;
	readonly h: number;
}

/** What a browser does with the template: track weights to fractions of the area. */
function edges(template: string): number[] {
	const weights = [...template.matchAll(/minmax\(0, (\d+)fr\)/g)].map((m) => Number(m[1]));
	const total = weights.reduce((a, b) => a + b, 0);
	const lines = [0];
	for (const w of weights) lines.push(lines[lines.length - 1] + w / total);
	return lines;
}

function layout(tiling: Tiling): Record<string, Rect> {
	const xs = edges(tiling.columns);
	const ys = edges(tiling.rows);
	const out: Record<string, Rect> = {};
	for (const t of tiling.tiles) {
		const [rowStart, colStart, rowEnd, colEnd] = t.area.split(" / ").map(Number);
		out[t.machine] = {
			x: xs[colStart - 1],
			y: ys[rowStart - 1],
			w: xs[colEnd - 1] - xs[colStart - 1],
			h: ys[rowEnd - 1] - ys[rowStart - 1],
		};
	}
	return out;
}

const names = (count: number): MachineName[] => Array.from({ length: count }, (_, i): MachineName => `node${i + 1}`);
const ROOMY: Grid = { cols: 3, rows: 2 };
const rect = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });

function expectLayout(tiling: Tiling, expected: Record<string, Rect>): void {
	const actual = layout(tiling);
	expect(Object.keys(actual)).toEqual(Object.keys(expected));
	for (const [name, want] of Object.entries(expected)) {
		for (const side of ["x", "y", "w", "h"] as const) {
			expect(actual[name][side], `${name}.${side}`).toBeCloseTo(want[side], 9);
		}
	}
}

describe("the tiling table", () => {
	test("no panes: no tiles", () => {
		expect(tile([], ROOMY).tiles).toEqual([]);
	});

	test("1: fills the area", () => {
		expectLayout(tile(names(1), ROOMY), { node1: rect(0, 0, 1, 1) });
	});

	test("2: two equal columns", () => {
		expectLayout(tile(names(2), ROOMY), { node1: rect(0, 0, 1 / 2, 1), node2: rect(1 / 2, 0, 1 / 2, 1) });
	});

	test("3: a main pane and a stack of two, split 3:2, the first in the list as main", () => {
		expectLayout(tile(["node2", "node1", "node3"], ROOMY), {
			node2: rect(0, 0, 3 / 5, 1),
			node1: rect(3 / 5, 0, 2 / 5, 1 / 2),
			node3: rect(3 / 5, 1 / 2, 2 / 5, 1 / 2),
		});
	});

	test("4: two by two, left to right, then down", () => {
		expectLayout(tile(names(4), ROOMY), {
			node1: rect(0, 0, 1 / 2, 1 / 2),
			node2: rect(1 / 2, 0, 1 / 2, 1 / 2),
			node3: rect(0, 1 / 2, 1 / 2, 1 / 2),
			node4: rect(1 / 2, 1 / 2, 1 / 2, 1 / 2),
		});
	});

	test("5: three across, then two across", () => {
		expectLayout(tile(names(5), ROOMY), {
			node1: rect(0, 0, 1 / 3, 1 / 2),
			node2: rect(1 / 3, 0, 1 / 3, 1 / 2),
			node3: rect(2 / 3, 0, 1 / 3, 1 / 2),
			node4: rect(0, 1 / 2, 1 / 2, 1 / 2),
			node5: rect(1 / 2, 1 / 2, 1 / 2, 1 / 2),
		});
	});

	test("6: three by two", () => {
		expectLayout(tile(names(6), ROOMY), {
			node1: rect(0, 0, 1 / 3, 1 / 2),
			node2: rect(1 / 3, 0, 1 / 3, 1 / 2),
			node3: rect(2 / 3, 0, 1 / 3, 1 / 2),
			node4: rect(0, 1 / 2, 1 / 3, 1 / 2),
			node5: rect(1 / 3, 1 / 2, 1 / 3, 1 / 2),
			node6: rect(2 / 3, 1 / 2, 1 / 3, 1 / 2),
		});
	});
});

describe("smaller grids", () => {
	test("two panes in one column stack", () => {
		expectLayout(tile(names(2), { cols: 1, rows: 2 }), {
			node1: rect(0, 0, 1, 1 / 2),
			node2: rect(0, 1 / 2, 1, 1 / 2),
		});
	});

	test("three panes in one row sit side by side", () => {
		expectLayout(tile(names(3), { cols: 3, rows: 1 }), {
			node1: rect(0, 0, 1 / 3, 1),
			node2: rect(1 / 3, 0, 1 / 3, 1),
			node3: rect(2 / 3, 0, 1 / 3, 1),
		});
	});

	test("three panes in two columns keep main and stack, split evenly so the stack is no narrower than a column", () => {
		expectLayout(tile(names(3), { cols: 2, rows: 2 }), {
			node1: rect(0, 0, 1 / 2, 1),
			node2: rect(1 / 2, 0, 1 / 2, 1 / 2),
			node3: rect(1 / 2, 1 / 2, 1 / 2, 1 / 2),
		});
	});

	test("four panes in a three-column grid are still two by two", () => {
		expect(layout(tile(names(4), { cols: 3, rows: 2 })).node3).toEqual(rect(0, 1 / 2, 1 / 2, 1 / 2));
	});
});

describe("every layout", () => {
	const grids: Grid[] = [
		{ cols: 1, rows: 1 },
		{ cols: 1, rows: 2 },
		{ cols: 2, rows: 1 },
		{ cols: 2, rows: 2 },
		{ cols: 3, rows: 1 },
		{ cols: 3, rows: 2 },
	];
	const cases = grids.flatMap((grid) =>
		Array.from({ length: 9 }, (_, count) => ({ grid, count, label: `${count} in ${grid.cols}x${grid.rows}` })),
	);

	test.each(cases)("$label: one tile per pane, in order, covering the area without overlap", ({ grid, count }) => {
		const visible = names(count);
		const tiling = tile(visible, grid);
		expect(tiling.tiles.map((t) => t.machine)).toEqual(visible);
		const rects = Object.values(layout(tiling));
		const area = rects.reduce((sum, r) => sum + r.w * r.h, 0);
		expect(area).toBeCloseTo(count === 0 ? 0 : 1, 9);
		for (const [i, a] of rects.entries()) {
			expect(a.w).toBeGreaterThan(0);
			expect(a.h).toBeGreaterThan(0);
			for (const b of rects.slice(i + 1)) {
				const apart =
					a.x + a.w <= b.x + 1e-9 || b.x + b.w <= a.x + 1e-9 || a.y + a.h <= b.y + 1e-9 || b.y + b.h <= a.y + 1e-9;
				expect(apart, `tiles ${JSON.stringify(a)} and ${JSON.stringify(b)} overlap`).toBe(true);
			}
		}
	});
});
