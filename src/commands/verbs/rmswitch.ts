import {
	cablesOf,
	DEFAULT_SWITCH,
	endsFrom,
	type MachineName,
	type NicPort,
	nicLabel,
	nicPorts,
	type PortNo,
	type PortRef,
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
	/** The cables to other switches that went with it: the port each was in, and the port it has freed. */
	readonly cables: readonly { readonly port: PortNo; readonly to: PortRef }[];
}

const label = ({ machine, nic }: NicPort): string => nicLabel(machine, nic);
const toPort = (to: PortRef): string => `${to.switch} port ${to.port}`;

export const rmswitch = defineVerb({
	name: "rmswitch",
	about: "remove a switch and unplug what is in it",
	description: `Remove a switch. The NICs plugged into it are left unplugged, also after a reload, and their machines run on. link up then plugs such a NIC into ${DEFAULT_SWITCH}, as it does any NIC that is unplugged, and plug into any switch. Its cables to other switches are removed, which frees their ports there. ${DEFAULT_SWITCH} itself cannot be removed. Returns the NICs that were unplugged and the cables that were removed.`,
	danger: true,
	grammar: { switch: slots.addedSwitch() },
	example: { switch: "lan" },
	plan(a, lab) {
		// It may have gone since the line was read.
		const name = slots.readAddedSwitch(a.switch, lab);
		if (name instanceof slots.Miss) return refuse(String(name.message), "switch");
		const cables = cablesOf(lab, name).map((cable) => {
			const [near, to] = endsFrom(cable, name);
			return { port: near.port, to };
		});
		return { name, held: nicPorts(lab, name), cables };
	},
	describe({ name, held, cables }) {
		const goes = [
			...(held.length === 0 ? [] : [`unplugs ${andList(held.map(label))}`]),
			...(cables.length === 0
				? []
				: [
						`removes the ${cables.length === 1 ? "cable" : "cables"} to ${andList(cables.map(({ to }) => toPort(to)))}`,
					]),
		];
		return [`remove ${name}`, ...(goes.length === 0 ? ["nothing is plugged in"] : goes)].join(" · ");
	},
	confirm({ name, held, cables }) {
		const nics = held.map((cable) => `${label(cable)} from port ${cable.port}`);
		const between = cables.map(({ port, to }) => `from port ${port} to ${toPort(to)}`);
		const detail =
			held.length === 0 && cables.length === 0
				? ["Nothing is plugged into it."]
				: [
						...(held.length === 0
							? []
							: [
									`This unplugs ${andList(nics)}.`,
									`The machines run on, and link up plugs a NIC that is unplugged into ${DEFAULT_SWITCH}.`,
								]),
						...(cables.length === 0
							? []
							: [`This removes the ${cables.length === 1 ? "cable" : "cables"} ${andList(between)}.`]),
					];
		return {
			question: `Remove ${name}?`,
			detail: [...detail, "Its MAC table and counters are gone.", "There is no undo."].join(" "),
			actionLabel: `Remove ${name}`,
			switch: name,
			machines: held.map(({ machine: { n, name } }) => ({ n, name })),
		};
	},
	async execute({ name, held, cables }, ctx, deps) {
		deps.dispatch({ type: "cmd/switch-remove", switch: name, cause: ctx.source });
		await deps.until((s) => !s.switches.includes(name), ctx.signal);
		const unplugged = held.map(({ machine, nic }) => ({ machine: machine.name, nic: nicName(nic) }));
		const text = [
			`removed ${name}`,
			...(held.length === 0 ? [] : [`${andList(held.map(label))} unplugged`]),
			...(cables.length === 0
				? []
				: [`${cables.length === 1 ? "cable" : "cables"} to ${andList(cables.map(({ to }) => toPort(to)))} removed`]),
		].join(" · ");
		return { kind: "visible", text, data: { removed: name, unplugged, cables } satisfies RemovedSwitch };
	},
	tool: {
		name: "switch_remove",
		title: "Remove a switch",
		policy: "ask",
		annotations: { consequentialHint: true },
	},
});
