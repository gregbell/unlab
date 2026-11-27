/**
 * What makes a name or a note in a Topology window hard to read: a line across it, another node's picture, name or
 * note over it, a box that cuts it off where no scrolling reaches, or its not being drawn at all. Empty when every one
 * can be read.
 *
 * It refers to nothing outside itself, so a script can also hand it to a page to run there.
 */
export function unreadable(map: Element): string[] {
	const nodes = [...map.querySelectorAll<HTMLElement>(".n-node")].map((node) => ({
		who: node.dataset.machine ?? node.dataset.switch ?? "?",
		// The frame drawn round a node's art.
		node: node.querySelector(".n-art")?.parentElement ?? null,
		name: node.querySelector("strong"),
		note: node.querySelector("small"),
	}));
	const words = nodes.flatMap(({ who, name, note }) =>
		[
			{ who, what: "name", el: name },
			{ who, what: "note", el: note },
		].flatMap(({ el, ...rest }) =>
			el?.textContent?.trim() ? [{ ...rest, el, rect: el.getBoundingClientRect() }] : [],
		),
	);
	const boxes = [
		...nodes.flatMap(({ who, node }) => (node ? [{ who, what: "node", rect: node.getBoundingClientRect() }] : [])),
		...words,
	];
	// Boxes that only touch are apart.
	const meet = (a: DOMRect, b: DOMRect) =>
		a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
	const lines = [...map.querySelectorAll<SVGPathElement>(".wire")].map((wire) => {
		const matrix = wire.getScreenCTM() ?? undefined;
		const length = wire.getTotalLength();
		const steps = Math.ceil(length / 1.5);
		return {
			reach: Number.parseFloat(getComputedStyle(wire).strokeWidth) / 2,
			points: Array.from({ length: steps + 1 }, (_, i) =>
				wire.getPointAtLength((i / Math.max(1, steps)) * length).matrixTransform(matrix),
			),
		};
	});
	const crossed = (rect: DOMRect) =>
		lines.some(({ reach, points }) =>
			points.some(
				(p) =>
					p.x > rect.left - reach && p.x < rect.right + reach && p.y > rect.top - reach && p.y < rect.bottom + reach,
			),
		);
	// A box that scrolls shows all of what it holds, a box that clips only what lies in it, and neither what is before its start.
	const cutOff = (el: Element, rect: DOMRect) => {
		const own = getComputedStyle(el);
		if (own.overflowX !== "visible" && el.scrollWidth > el.clientWidth + 1) return true;
		if (own.overflowY !== "visible" && el.scrollHeight > el.clientHeight + 1) return true;
		for (let box = el.parentElement; box && map.contains(box); box = box.parentElement) {
			const style = getComputedStyle(box);
			const outer = box.getBoundingClientRect();
			const scrolls = (flow: string) => flow === "auto" || flow === "scroll";
			const across = scrolls(style.overflowX);
			const down = scrolls(style.overflowY);
			const left = outer.left + box.clientLeft - (across ? box.scrollLeft : 0);
			const top = outer.top + box.clientTop - (down ? box.scrollTop : 0);
			if (
				(style.overflowX !== "visible" &&
					(rect.left < left - 0.5 || rect.right > left + (across ? box.scrollWidth : box.clientWidth) + 0.5)) ||
				(style.overflowY !== "visible" &&
					(rect.top < top - 0.5 || rect.bottom > top + (down ? box.scrollHeight : box.clientHeight) + 0.5))
			)
				return true;
			if (across || down) return false;
		}
		return false;
	};
	return words.flatMap(({ who, what, el, rect }) => [
		...(rect.width > 0 && rect.height > 0 ? [] : [`${who}'s ${what} is not drawn`]),
		...(crossed(rect) ? [`a line across ${who}'s ${what}`] : []),
		...boxes
			.filter((other) => other.who !== who && meet(rect, other.rect))
			.map((other) => `${who}'s ${what} under ${other.who}'s ${other.what}`),
		...(cutOff(el, rect) ? [`${who}'s ${what} is cut off`] : []),
	]);
}
