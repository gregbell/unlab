import {
	DEFAULT_SWITCH,
	type HeldPort,
	heldPorts,
	type MachineName,
	nicLabel,
	type SwitchName,
} from "../../model/index.ts";
import { type NicName, nicName } from "../../net/index.ts";
import { defineVerb, refuse } from "../define.ts";
import * as slots from "../grammar/slots.ts";
import { andList } from "./words.ts";

export interface RemovedSwitch {
	readonly removed: SwitchName;
	/** The NICs that were plugged into it, in port order. */
	readonly unplugged: readonly { readonly machine: MachineName; readonly nic: NicName }[];
}

const label = ({ machine, nic }: HeldPort): string => nicLabel(machine, nic);

export const rmswitch = defineVerb({
	name: "rmswitch",
	about: "remove a switch and unplug what is in it",
	description: `Remove a switch. The NICs plugged into it are left unplugged, also after a reload, and their machines run on. link up then plugs such a NIC into ${DEFAULT_SWITCH}, as it does any NIC that is unplugged, and plug into any switch. ${DEFAULT_SWITCH} itself cannot be removed. Returns the NICs that were unplugged.`,
	danger: true,
	grammar: { switch: slots.addedSwitch() },
	example: { switch: "lan" },
	plan(a, lab) {
		// It may have gone since the line was read.
		const name = slots.readAddedSwitch(a.switch, lab);
		if (name instanceof slots.Miss) return refuse(String(name.message), "switch");
		return { name, held: heldPorts(lab, name) };
	},
	describe: ({ name, held }) =>
		[`remove ${name}`, held.length === 0 ? "nothing is plugged in" : `unplugs ${andList(held.map(label))}`].join(" · "),
	confirm({ name, held }) {
		const cables = held.map((cable) => `${label(cable)} from port ${cable.port}`);
		const detail =
			held.length === 0
				? ["Nothing is plugged into it."]
				: [
						`This unplugs ${andList(cables)}.`,
						`The machines run on, and link up plugs a NIC that is unplugged into ${DEFAULT_SWITCH}.`,
					];
		return {
			question: `Remove ${name}?`,
			detail: [...detail, "Its MAC table and counters are gone.", "There is no undo."].join(" "),
			actionLabel: `Remove ${name}`,
			switch: name,
			machines: held.map(({ machine: { n, name } }) => ({ n, name })),
		};
	},
	async execute({ name, held }, ctx, deps) {
		deps.dispatch({ type: "cmd/switch-remove", switch: name, cause: ctx.source });
		await deps.until((s) => !s.switches.includes(name), ctx.signal);
		const unplugged = held.map(({ machine, nic }) => ({ machine: machine.name, nic: nicName(nic) }));
		const text = [`removed ${name}`, ...(held.length === 0 ? [] : [`${andList(held.map(label))} unplugged`])].join(
			" · ",
		);
		return { kind: "visible", text, data: { removed: name, unplugged } satisfies RemovedSwitch };
	},
	tool: {
		name: "switch_remove",
		title: "Remove a switch",
		policy: "ask",
		annotations: { consequentialHint: true },
	},
});
