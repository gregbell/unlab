import type { LabState, PlanError } from "../../model/index.ts";
import type { Selection } from "../grammar/slots.ts";

/** `node1`, `node1 and node2`, `node1, node2 and node3`. */
export function andList(words: readonly (string | number)[]): string {
	if (words.length < 2) return words.join("");
	return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** `1 shell`, `2 shells`. */
export function count(n: number, one: string, many = `${one}s`): string {
	return `${n} ${n === 1 ? one : many}`;
}

/** `port 3`, `ports 3 and 4`. */
export function ports(list: readonly number[]): string {
	return `${list.length === 1 ? "port" : "ports"} ${andList(list)}`;
}

/** The preview's tail for machines a selection left out: `skipped node4: still booting`. */
export function skippedPart(skipped: Selection["skipped"]): string[] {
	return skipped.length === 0 ? [] : [`skipped ${skipped.map((s) => `${s.name}: ${s.reason}`).join(", ")}`];
}

/** A plan error from the model, as the verb says it. `ports` is what would make the switch's ports enough. */
export function planErrorSentence(error: PlanError, ports = "Remove a machine with rm to free its ports."): string {
	switch (error.kind) {
		case "no-ports":
			return `switch0 has ${count(error.free, "free port")}, and this takes ${error.wanted}. ${ports}`;
		case "no-room":
			return error.free === 0
				? "The lab has no room for another machine. Remove one with rm first."
				: `The lab has room for ${count(error.free, "more machine")}, not ${error.wanted}.`;
		case "unknown-image":
			return `No image called ${error.image}.`;
	}
}

export function imageLabel(lab: LabState, image: string): string {
	return lab.images.find((i) => i.name === image)?.label ?? image;
}
