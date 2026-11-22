import fc from "fast-check";
import { describe, expect, test } from "vitest";
import {
	addPanes,
	capacity,
	emptyPanes,
	focusPane,
	gridFor,
	parkedPanes,
	parkPane,
	promotePane,
	reconcilePanes,
	removePane,
	resizeArea,
	toggleMaximise,
	visiblePanes,
} from "./panes.ts";
import { tile } from "./tiling.ts";
import type { MachineName, Panes, PanesParked, ParkReason } from "./types.ts";

const name = (n: number): MachineName => `node${n}`;
const names = (count: number): MachineName[] => Array.from({ length: count }, (_, i) => name(i + 1));

/** Panes for node1..node<count> in an area of `cols` by `rows` panes. */
function panes(count: number, cols: number, rows: number): Panes {
	return addPanes(emptyPanes(gridFor(cols * 400, rows * 200)), names(count));
}

describe("capacity", () => {
	test.each([
		[0, 0, 1, 1],
		[399, 199, 1, 1],
		[799, 399, 1, 1],
		[800, 400, 2, 2],
		[1199, 400, 2, 2],
		[1200, 399, 3, 1],
		[5000, 5000, 3, 2],
	])("an area of %i by %i holds %i columns and %i rows", (width, height, cols, rows) => {
		expect(gridFor(width, height)).toEqual({ cols, rows });
		expect(capacity(emptyPanes(gridFor(width, height)))).toBe(cols * rows);
	});
});

describe("adding and removing", () => {
	test("a new machine goes to the end", () => {
		const p = addPanes(panes(2, 3, 2), ["node3"]);
		expect(p.order).toEqual(["node1", "node2", "node3"]);
		expect(visiblePanes(p)).toEqual(["node1", "node2", "node3"]);
	});

	test("adding a pane that is already there changes nothing", () => {
		const p = panes(2, 3, 2);
		expect(addPanes(p, ["node2"])).toBe(p);
	});

	test("eight machines in an area for six: the last two park themselves", () => {
		const p = panes(8, 3, 2);
		expect(visiblePanes(p)).toEqual(names(6));
		expect(p.parked).toEqual({ node7: "auto", node8: "auto" });
	});

	test("with no room, the pane focused longest ago parks for a newcomer", () => {
		let p = panes(2, 2, 1);
		p = focusPane(p, "node1");
		p = focusPane(p, "node2");
		p = addPanes(p, ["node3"]);
		expect(visiblePanes(p)).toEqual(["node2", "node3"]);
		expect(p.parked).toEqual({ node1: "auto" });
	});

	test("the pane focused last never parks for a newcomer", () => {
		let p = panes(2, 2, 1);
		p = focusPane(p, "node1");
		p = addPanes(p, ["node3", "node4"]);
		expect(visiblePanes(p)).toEqual(["node1", "node3"]);
		expect(p.parked).toEqual({ node2: "auto", node4: "auto" });
	});

	test("removing a pane makes room for an automatically parked one", () => {
		const p = removePane(panes(7, 3, 2), "node2");
		expect(p.order).toEqual(["node1", "node3", "node4", "node5", "node6", "node7"]);
		expect(p.parked).toEqual({});
	});

	test("removing a pane that is not there changes nothing", () => {
		const p = panes(2, 3, 2);
		expect(removePane(p, "node9")).toBe(p);
	});
});

describe("focus", () => {
	test("focusing never moves a pane", () => {
		const p = panes(4, 3, 2);
		const focused = focusPane(p, "node3");
		expect(focused.order).toEqual(p.order);
		expect(visiblePanes(focused)).toEqual(visiblePanes(p));
	});

	test("focusing the pane that already has the focus changes nothing", () => {
		const p = focusPane(panes(3, 3, 2), "node2");
		expect(focusPane(p, "node2")).toBe(p);
	});

	test("focusing a parked pane brings it back", () => {
		const p = focusPane(parkPane(panes(3, 3, 2), "node2"), "node2");
		expect(visiblePanes(p)).toEqual(["node1", "node2", "node3"]);
		expect(p.parked).toEqual({});
	});

	test("with no room, the pane focused longest ago parks in exchange", () => {
		let p = panes(3, 2, 1);
		expect(p.parked).toEqual({ node3: "auto" });
		p = focusPane(p, "node2");
		p = focusPane(p, "node1");
		p = focusPane(p, "node3");
		expect(visiblePanes(p)).toEqual(["node1", "node3"]);
		expect(p.parked).toEqual({ node2: "auto" });
	});

	test("focusing a pane that is not there changes nothing", () => {
		const p = panes(2, 3, 2);
		expect(focusPane(p, "node9")).toBe(p);
	});
});

describe("parking", () => {
	test("the park button parks by hand, and the strip lists parked panes in pane order", () => {
		let p = panes(4, 3, 2);
		p = parkPane(p, "node3");
		p = parkPane(p, "node1");
		expect(p.parked).toEqual({ node1: "user", node3: "user" });
		expect(parkedPanes(p)).toEqual(["node1", "node3"]);
		expect(visiblePanes(p)).toEqual(["node2", "node4"]);
	});

	test("when capacity grows, automatically parked panes return, most recently focused first", () => {
		let p = panes(4, 3, 2);
		for (const m of names(4)) p = focusPane(p, m);
		p = resizeArea(p, 400, 200);
		expect(visiblePanes(p)).toEqual(["node4"]);
		p = resizeArea(p, 800, 200);
		expect(visiblePanes(p)).toEqual(["node3", "node4"]);
		p = resizeArea(p, 1200, 200);
		expect(visiblePanes(p)).toEqual(["node2", "node3", "node4"]);
	});

	test("panes parked by the user stay parked when capacity grows", () => {
		let p = parkPane(panes(3, 1, 1), "node1");
		p = resizeArea(p, 1200, 400);
		expect(p.parked).toEqual({ node1: "user" });
		expect(visiblePanes(p)).toEqual(["node2", "node3"]);
	});

	test("a resize that does not change the grid changes nothing", () => {
		const p = panes(3, 3, 2);
		expect(resizeArea(p, 1250, 450)).toBe(p);
	});
});

describe("promote", () => {
	test("moves a pane to the front of the list", () => {
		const p = promotePane(panes(4, 3, 2), "node3");
		expect(p.order).toEqual(["node3", "node1", "node2", "node4"]);
	});

	test("the front pane stays where it is", () => {
		const p = panes(3, 3, 2);
		expect(promotePane(p, "node1")).toBe(p);
	});
});

describe("maximise", () => {
	test("gives one pane the whole area and parks the rest automatically", () => {
		const p = toggleMaximise(panes(4, 3, 2), "node2");
		expect(visiblePanes(p)).toEqual(["node2"]);
		expect(p.parked).toEqual({ node1: "auto", node3: "auto", node4: "auto" });
		expect(capacity(p)).toBe(1);
	});

	test("maximise again restores the exact previous layout", () => {
		const before = parkPane(panes(8, 3, 2), "node3");
		const after = toggleMaximise(toggleMaximise(before, "node2"), "node2");
		expect(after).toEqual(before);
	});

	test("focusing another pane ends the maximise and brings the layout back", () => {
		const before = panes(4, 3, 2);
		const p = focusPane(toggleMaximise(before, "node2"), "node4");
		expect(p.maximised).toBeNull();
		expect(visiblePanes(p)).toEqual(names(4));
	});

	test("a machine added while maximised waits in the strip, then shows after restore", () => {
		let p = toggleMaximise(panes(2, 3, 2), "node1");
		p = addPanes(p, ["node3"]);
		expect(visiblePanes(p)).toEqual(["node1"]);
		p = toggleMaximise(p, "node1");
		expect(visiblePanes(p)).toEqual(["node1", "node2", "node3"]);
	});

	test("removing the maximised machine restores the others", () => {
		const p = removePane(toggleMaximise(parkPane(panes(4, 3, 2), "node4"), "node2"), "node2");
		expect(p.maximised).toBeNull();
		expect(visiblePanes(p)).toEqual(["node1", "node3"]);
		expect(p.parked).toEqual({ node4: "user" });
	});

	test("a machine removed while another is maximised is not restored", () => {
		let p = toggleMaximise(parkPane(panes(4, 3, 2), "node4"), "node2");
		p = removePane(p, "node4");
		p = toggleMaximise(p, "node2");
		expect(p.order).toEqual(["node1", "node2", "node3"]);
		expect(p.parked).toEqual({});
	});

	test("parking the maximised pane by hand ends the maximise", () => {
		const p = parkPane(toggleMaximise(panes(3, 3, 2), "node2"), "node2");
		expect(p.maximised).toBeNull();
		expect(p.parked).toEqual({ node2: "user" });
		expect(visiblePanes(p)).toEqual(["node1", "node3"]);
	});

	test("maximising a second pane swaps it in and still restores the first layout", () => {
		const before = panes(3, 3, 2);
		const p = toggleMaximise(toggleMaximise(before, "node1"), "node3");
		expect(visiblePanes(p)).toEqual(["node3"]);
		expect(visiblePanes(toggleMaximise(p, "node3"))).toEqual(names(3));
	});
});

type Op =
	| { readonly op: "add"; readonly count: number }
	| { readonly op: "remove" | "focus" | "park" | "promote" | "maximise"; readonly pick: number }
	| { readonly op: "resize"; readonly width: number; readonly height: number };

const pick = fc.nat({ max: 20 });
const opArb: fc.Arbitrary<Op> = fc.oneof(
	{ weight: 3, arbitrary: fc.record({ op: fc.constant("add" as const), count: fc.integer({ min: 1, max: 3 }) }) },
	{ weight: 1, arbitrary: fc.record({ op: fc.constant("remove" as const), pick }) },
	{ weight: 4, arbitrary: fc.record({ op: fc.constant("focus" as const), pick }) },
	{ weight: 2, arbitrary: fc.record({ op: fc.constant("park" as const), pick }) },
	{ weight: 1, arbitrary: fc.record({ op: fc.constant("promote" as const), pick }) },
	{ weight: 2, arbitrary: fc.record({ op: fc.constant("maximise" as const), pick }) },
	{
		weight: 2,
		arbitrary: fc.record({
			op: fc.constant("resize" as const),
			width: fc.integer({ min: 0, max: 1700 }),
			height: fc.integer({ min: 0, max: 700 }),
		}),
	},
);
const opsArb = fc.array(opArb, { maxLength: 40 });
const areaArb = fc.record({ width: fc.integer({ min: 0, max: 1700 }), height: fc.integer({ min: 0, max: 700 }) });

function apply(p: Panes, op: Op, next: { n: number }): Panes {
	if (op.op === "add")
		return addPanes(
			p,
			Array.from({ length: op.count }, () => name(next.n++)),
		);
	if (op.op === "resize") return resizeArea(p, op.width, op.height);
	if (p.order.length === 0) return p;
	const m = p.order[op.pick % p.order.length];
	if (op.op === "remove") return removePane(p, m);
	if (op.op === "focus") return focusPane(p, m);
	if (op.op === "park") return parkPane(p, m);
	if (op.op === "promote") return promotePane(p, m);
	return toggleMaximise(p, m);
}

/** Every state the pane functions can reach from an empty area, with the invariants checked on the way. */
function reach(ops: readonly Op[], check: (p: Panes) => void = () => {}): Panes {
	const next = { n: 1 };
	let p = emptyPanes(gridFor(1200, 400));
	for (const op of ops) {
		p = apply(p, op, next);
		check(p);
	}
	return p;
}

/** Panes the user parked that are out of sight. While one pane is maximised the reasons live in `before`. */
const userParked = (p: Panes): MachineName[] => {
	const parked = p.maximised ? p.maximised.before : p.parked;
	return p.order.filter((m) => parked[m] === "user" && m !== p.maximised?.machine);
};

describe("pane properties", () => {
	test("visible panes never exceed capacity, and nothing is lost or left dangling", () => {
		fc.assert(
			fc.property(opsArb, (ops) => {
				reach(ops, (p) => {
					const visible = visiblePanes(p);
					expect(visible.length).toBeLessThanOrEqual(capacity(p));
					expect(new Set(p.order).size).toBe(p.order.length);
					expect(p.order).toEqual(expect.arrayContaining(Object.keys(p.parked)));
					expect(p.order).toEqual(expect.arrayContaining(Object.keys(p.focusStamp)));
					if (p.maximised) expect(visible).toEqual([p.maximised.machine]);
					const waiting = p.order.some((m) => p.parked[m] === "auto");
					if (waiting && !p.maximised) expect(visible.length).toBe(capacity(p));
				});
			}),
		);
	});

	test("the layout never makes a pane narrower than 400px or shorter than 200px", () => {
		fc.assert(
			fc.property(
				opsArb,
				fc.integer({ min: 400, max: 2400 }),
				fc.integer({ min: 200, max: 1400 }),
				(ops, width, height) => {
					const p = resizeArea(reach(ops), width, height);
					const tiling = tile(visiblePanes(p), p.grid);
					const share = (template: string): number[] => {
						const weights = [...template.matchAll(/(\d+)fr/g)].map((m) => Number(m[1]));
						const total = weights.reduce((a, b) => a + b, 0);
						return weights.map((w) => w / total);
					};
					const cols = share(tiling.columns);
					const rows = share(tiling.rows);
					for (const t of tiling.tiles) {
						const [rowStart, colStart, rowEnd, colEnd] = t.area.split(" / ").map(Number);
						const w = cols.slice(colStart - 1, colEnd - 1).reduce((a, b) => a + b, 0) * width;
						const h = rows.slice(rowStart - 1, rowEnd - 1).reduce((a, b) => a + b, 0) * height;
						expect(w).toBeGreaterThanOrEqual(400 - 1e-6);
						expect(h).toBeGreaterThanOrEqual(200 - 1e-6);
					}
				},
			),
		);
	});

	test("focus never changes the order", () => {
		fc.assert(
			fc.property(opsArb, pick, (ops, i) => {
				const p = reach(ops);
				fc.pre(p.order.length > 0);
				expect(focusPane(p, p.order[i % p.order.length]).order).toEqual(p.order);
			}),
		);
	});

	test("focusing a visible pane moves nothing", () => {
		fc.assert(
			fc.property(opsArb, pick, (ops, i) => {
				const p = reach(ops);
				const visible = visiblePanes(p);
				fc.pre(visible.length > 0);
				const focused = focusPane(p, visible[i % visible.length]);
				expect(visiblePanes(focused)).toEqual(visible);
				expect(focused.parked).toEqual(p.parked);
			}),
		);
	});

	test("focusing a parked pane brings it back, parking at most one other in exchange", () => {
		fc.assert(
			fc.property(opsArb, pick, (ops, i) => {
				const p = reach(ops);
				const parked = parkedPanes(p);
				fc.pre(parked.length > 0 && !p.maximised);
				const m = parked[i % parked.length];
				const focused = focusPane(p, m);
				const visible = visiblePanes(focused);
				expect(visible).toContain(m);
				const displaced = visiblePanes(p).filter((v) => !visible.includes(v));
				expect(displaced.length).toBeLessThanOrEqual(1);
				for (const d of displaced) expect(focused.parked[d]).toBe("auto");
			}),
		);
	});

	test("reconcile is idempotent, from any parking at all", () => {
		const reason = fc.constantFrom<ParkReason | null>("auto", "user", null);
		const anyPanes = fc
			.record({
				count: fc.integer({ min: 0, max: 10 }),
				reasons: fc.array(reason, { minLength: 10, maxLength: 10 }),
				stamps: fc.array(fc.nat({ max: 12 }), { minLength: 10, maxLength: 10 }),
				area: areaArb,
			})
			.map(({ count, reasons, stamps, area }): Panes => {
				const order = names(count);
				const parked: Partial<Record<MachineName, ParkReason>> = {};
				const focusStamp: Partial<Record<MachineName, number>> = {};
				order.forEach((m, i) => {
					const r = reasons[i];
					if (r) parked[m] = r;
					if (stamps[i] > 0) focusStamp[m] = stamps[i];
				});
				return { order, parked, focusStamp, focusClock: 12, maximised: null, grid: gridFor(area.width, area.height) };
			});
		fc.assert(
			fc.property(anyPanes, (p) => {
				const once = reconcilePanes(p);
				expect(visiblePanes(once).length).toBeLessThanOrEqual(capacity(once));
				expect(reconcilePanes(once)).toBe(once);
				expect(once.order).toEqual(p.order);
				for (const m of p.order) if (p.parked[m] === "user") expect(once.parked[m]).toBe("user");
			}),
		);
	});

	test("every pane function leaves the panes reconciled", () => {
		fc.assert(
			fc.property(opsArb, (ops) => {
				reach(ops, (p) => expect(reconcilePanes(p)).toBe(p));
			}),
		);
	});

	test("maximise then maximise restores the parking exactly", () => {
		fc.assert(
			fc.property(opsArb, pick, (ops, i) => {
				const p = reach(ops);
				fc.pre(p.order.length > 0 && !p.maximised);
				const m = p.order[i % p.order.length];
				const maximised = toggleMaximise(p, m);
				expect(visiblePanes(maximised)).toEqual([m]);
				const restored = toggleMaximise(maximised, m);
				const exact: PanesParked = p.parked;
				expect(restored.parked).toEqual(exact);
				expect(restored).toEqual(p);
			}),
		);
	});

	test("panes parked by the user never come back on a resize", () => {
		fc.assert(
			fc.property(opsArb, fc.array(areaArb, { minLength: 1, maxLength: 5 }), (ops, areas) => {
				let p = reach(ops);
				const byHand = userParked(p);
				for (const area of areas) {
					p = resizeArea(p, area.width, area.height);
					expect(userParked(p)).toEqual(byHand);
					for (const m of byHand) expect(visiblePanes(p)).not.toContain(m);
				}
			}),
		);
	});
});
