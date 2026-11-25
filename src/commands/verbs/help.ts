import { type AnyVerb, defineVerb } from "../define.ts";
import * as slots from "../grammar/slots.ts";
import type { Manual, ManualArgument } from "../manual.ts";
import type { ReportRow } from "../types.ts";
import { count, noVerb } from "./words.ts";

/** A verb, by its name or by its tool's. */
function verbName(manuals: () => readonly Manual[]): slots.Value<Manual> {
	return {
		kind: "positional",
		label: "verb",
		noun: "a verb such as spawn",
		about: "The verb to explain, such as spawn, or its tool. Left out, every verb.",
		read(text) {
			const found = manuals().find(({ verb, tool }) => verb === text || tool === text);
			const names = manuals().map(({ verb }) => verb);
			return found ?? new slots.Miss(noVerb(text, names));
		},
		suggest: () => manuals().map(({ verb, about }) => ({ insert: verb, label: verb, detail: about })),
		format: ({ verb }) => verb,
		schema: { type: "string" },
	};
}

function argumentRow({ written, about, default: left }: ManualArgument): ReportRow {
	return { term: written, text: left === null ? about : `${about} Left out, ${left}.` };
}

function rowsOf({ description, arguments: args, example, tool }: Manual): readonly ReportRow[] {
	return [
		{ term: "does", text: description },
		...args.map(argumentRow),
		{ term: "example", text: example.line },
		...(tool === null ? [] : [{ term: "agent tool", text: tool }]),
	];
}

/** `verbs` is asked when a line is read, so that help can be one of them. */
export function helpFor(verbs: () => readonly AnyVerb[]) {
	const manuals = () => verbs().map((verb) => verb.manual);
	return defineVerb({
		name: "help",
		about: "list the verbs, or explain one",
		description:
			"Explain the lab's verbs, which are also its tools. With no verb, returns each with one line of what it does and its tool. With one, returns its arguments, each under its tool field and as typed in the command bar, and one example.",
		danger: false,
		grammar: { verb: slots.optional(verbName(manuals)) },
		example: { verb: "spawn" },
		plan: ({ verb }) => ({ verb }),
		describe: ({ verb }) => (verb === null ? "list every verb" : `explain ${verb.verb}`),
		async execute({ verb }) {
			if (verb !== null) return { kind: "report", header: verb.usage, blocks: [], rows: rowsOf(verb), data: verb };
			const all = manuals();
			return {
				kind: "report",
				header: count(all.length, "verb"),
				blocks: [],
				rows: all.map(({ verb, about }) => ({ term: verb, text: about })),
				data: all.map(({ verb, about, tool }) => ({ verb, about, tool })),
			};
		},
		tool: { name: "lab_help", title: "Explain the lab's verbs", policy: "run", annotations: { readOnlyHint: true } },
	});
}
