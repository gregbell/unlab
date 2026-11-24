import { html, type TemplateResult } from "lit";
import type { HueNo, LabState } from "../../model/index.ts";

/**
 * `text` with every machine the lab has written in its hue, as the artboards
 * write `Remove node3?`. Other words stay as they are.
 */
export function hued(text: string, machines: LabState["machines"]): (string | TemplateResult)[] {
	const hues = new Map<string, HueNo>();
	for (const machine of Object.values(machines)) if (machine) hues.set(machine.name, machine.hue);
	if (hues.size === 0) return [text];
	const names = [...hues.keys()].sort((a, b) => b.length - a.length);
	// A hyphen is part of a name, so `web` is not in `web-1`.
	return text.split(new RegExp(`(?<![\\w-])(${names.join("|")})(?![\\w-])`)).map((part, i) => {
		const hue = i % 2 === 1 ? hues.get(part) : undefined;
		return hue === undefined ? part : html`<span class="machine" data-hue=${hue}>${part}</span>`;
	});
}
