// How a cable treats the frames that cross it. The conditions are the cable's,
// as its cut is: they go where it is moved, and are gone when it is taken out.
// The switches hold them by the port a cable is in, and `settleConditions`
// tells them after every change, so no path that moves, unplugs or removes a
// cable has to.

import { heldPorts, machineList, plugsOf, samePort, type Wiring } from "./machines.ts";
import { step } from "./step.ts";
import {
	type CableCounters,
	type ConditionPart,
	type Conditions,
	type ConditionsChange,
	type DropReason,
	type Effect,
	type LabState,
	NO_CONDITIONS,
	type PortRef,
	type Step,
} from "./types.ts";

/** In the order they are written and said. */
export const CONDITION_PARTS: readonly ConditionPart[] = ["delay", "loss", "reorder", "rate", "mtu"];

export const MAX_DELAY_MS = 10_000;
export const MIN_RATE = 1_000;
export const MAX_RATE = 10_000_000_000;
export const MIN_MTU = 68;
/** What Ethernet carries, and so what a cable with no MTU of its own does. */
export const ETH_MTU = 1500;

interface Part {
	/** The value that takes the part away. */
	readonly none: number;
	/** Whether a cable can have the value. */
	fits(value: number): boolean;
	/** What a person wrote, `none` too. Null for what is no value of the part. */
	parse(text: string): number | null;
	/** As a command takes it: `100ms`. */
	written(value: number): string;
	/** As a sentence has it: `delay 100 ms`. */
	text(value: number): string;
}

const number = (text: string): number => Number(text);

/** `20`, `20%`, `0.5%`. */
function share(name: string): Part {
	return {
		none: 0,
		fits: (value) => value > 0 && value <= 100,
		parse(text) {
			const read = /^(\d+(?:\.\d+)?)%?$/.exec(text);
			return read ? number(read[1]) : null;
		},
		written: (value) => `${value}%`,
		text: (value) => `${name} ${value}%`,
	};
}

const RATE_UNITS = [
	{ letter: "g", word: "Gbit/s", bits: 1_000_000_000 },
	{ letter: "m", word: "Mbit/s", bits: 1_000_000 },
	{ letter: "k", word: "kbit/s", bits: 1_000 },
	{ letter: "", word: "bit/s", bits: 1 },
] as const;

/** The largest unit that the rate is a whole number of `step`s of: 1 for whole numbers, 1000 for three decimals. */
function rateIn(value: number, step: number): { readonly count: number; readonly unit: (typeof RATE_UNITS)[number] } {
	const unit = RATE_UNITS.find(({ bits }) => value >= bits && value % Math.max(1, bits / step) === 0) ?? RATE_UNITS[3];
	return { count: value / unit.bits, unit };
}

const PARTS: Readonly<Record<ConditionPart, Part>> = {
	delay: {
		none: 0,
		fits: (value) => Number.isInteger(value) && value > 0 && value <= MAX_DELAY_MS,
		parse(text) {
			const read = /^(\d+(?:\.\d+)?)(ms|s)?$/i.exec(text);
			if (!read) return null;
			// A second is a thousand of them, to the ms: 1.5s is 1500.
			return read[2]?.toLowerCase() === "s" ? Math.round(number(read[1]) * 1e6) / 1e3 : number(read[1]);
		},
		written: (value) => `${value}ms`,
		text: (value) => `delay ${value} ms`,
	},
	loss: share("loss"),
	reorder: share("reorder"),
	rate: {
		none: 0,
		fits: (value) => Number.isInteger(value) && value >= MIN_RATE && value <= MAX_RATE,
		parse(text) {
			if (text === "0") return 0;
			const read = /^(\d+(?:\.\d+)?)([kmg]?)bit(?:\/s)?$/i.exec(text);
			const unit = read && RATE_UNITS.find(({ letter }) => letter === read[2].toLowerCase());
			return read && unit ? Math.round(number(read[1]) * unit.bits * 1e3) / 1e3 : null;
		},
		written(value) {
			const { count, unit } = rateIn(value, 1);
			return `${count}${unit.letter}bit`;
		},
		text(value) {
			const { count, unit } = rateIn(value, 1000);
			return `rate ${count} ${unit.word}`;
		},
	},
	mtu: {
		none: ETH_MTU,
		fits: (value) => Number.isInteger(value) && value >= MIN_MTU && value < ETH_MTU,
		parse: (text) => (/^\d{1,4}$/.test(text) ? number(text) : null),
		written: String,
		text: (value) => `mtu ${value}`,
	},
};

/** A value for each part that a command gives. One that takes its part away is `none` of that part. */
export type ConditionValues = Readonly<Partial<Record<ConditionPart, number>>>;

export type ConditionsFault =
	/** A part has a value that no cable can have. */
	| { readonly kind: "out-of-range"; readonly part: ConditionPart }
	/** Reordering is frames that skip the delay, so there has to be one. */
	| { readonly kind: "reorder-needs-delay" };

export function isConditionsFault(read: Conditions | ConditionsFault): read is ConditionsFault {
	return "kind" in read;
}

/** What a person wrote for the part, as its number, or null. A value that takes the part away is read too. */
export function parseCondition(part: ConditionPart, text: string): number | null {
	const { parse, none, fits } = PARTS[part];
	const value = parse(text);
	return value !== null && (value === none || fits(value)) ? value : null;
}

/** One part's value as a command takes it: `100ms`, `20%`, `1mbit`, `1400`. */
export function writeCondition(part: ConditionPart, value: number): string {
	return PARTS[part].written(value);
}

/** The only way conditions are made: each part in its range, and none that does nothing. */
export function conditionsOf(values: ConditionValues): Conditions | ConditionsFault {
	const kept: Partial<Record<ConditionPart, number>> = {};
	for (const part of CONDITION_PARTS) {
		const value = values[part];
		if (value === undefined || value === PARTS[part].none) continue;
		if (!PARTS[part].fits(value)) return { kind: "out-of-range", part };
		kept[part] = value;
	}
	if (kept.reorder !== undefined && kept.delay === undefined) return { kind: "reorder-needs-delay" };
	return kept as Conditions;
}

/** The cable's conditions with the given parts set, or taken away. */
export function withConditions(old: Conditions, values: ConditionValues): Conditions | ConditionsFault {
	return conditionsOf({ ...old, ...values });
}

export function hasConditions(conditions: Conditions): boolean {
	return CONDITION_PARTS.some((part) => conditions[part] !== undefined);
}

export function sameConditions(a: Conditions, b: Conditions): boolean {
	return CONDITION_PARTS.every((part) => a[part] === b[part]);
}

function said(conditions: Conditions, how: "written" | "text"): readonly (readonly [ConditionPart, string])[] {
	return CONDITION_PARTS.flatMap((part) => {
		const value = conditions[part];
		return value === undefined ? [] : [[part, PARTS[part][how](value)] as const];
	});
}

/** `delay 100 ms`, `loss 20%`, `rate 1 Mbit/s`: one for each part that the cable has. */
export function conditionWords(conditions: Conditions): readonly string[] {
	return said(conditions, "text").map(([, text]) => text);
}

/** Each part as a command takes it, so what a tool returns can be given back to it: `{ delay: "100ms", loss: "20%" }`. */
export type WrittenConditions = Readonly<Partial<Record<ConditionPart, string>>>;

export function writtenConditions(conditions: Conditions): WrittenConditions {
	return Object.fromEntries(said(conditions, "written"));
}

/** As a reason is written where a person reads it. */
export const DROP_WORD: Readonly<Record<DropReason, string>> = { loss: "loss", rate: "rate", mtu: "MTU" };

export const NOTHING_CARRIED: CableCounters = { delivered: 0, dropped: { loss: 0, rate: 0, mtu: 0 } };

/** `196 dropped (190 by loss, 6 by MTU)`, or null for cables that dropped nothing. */
export function droppedWords(cables: readonly CableCounters[]): string | null {
	const of = (reason: DropReason): number => cables.reduce((sum, { dropped }) => sum + dropped[reason], 0);
	const reasons = (Object.keys(DROP_WORD) as DropReason[]).filter((reason) => of(reason) > 0);
	if (reasons.length === 0) return null;
	const total = reasons.reduce((sum, reason) => sum + of(reason), 0);
	return `${total} dropped (${reasons.map((reason) => `${of(reason)} by ${DROP_WORD[reason]}`).join(", ")})`;
}

/** `804 delivered` and `196 dropped (190 by loss, 6 by MTU)`, or `0 dropped`. */
export function carriedWords(cable: CableCounters): readonly string[] {
	return [`${cable.delivered} delivered`, droppedWords([cable]) ?? "0 dropped"];
}

/** The conditions of the cable in the port. A port with no cable has none. */
export function conditionsAt(state: Wiring, port: PortRef): Conditions {
	return heldPorts(state, port.switch).find((held) => held.port === port.port)?.conditions ?? NO_CONDITIONS;
}

const kept = (conditions: Conditions): { readonly conditions?: Conditions } =>
	hasConditions(conditions) ? { conditions } : {};

/** Gives one cable its conditions. Ignored unless a cable is in the port, and has others now. */
function setOne(state: LabState, { port, conditions }: ConditionsChange): LabState {
	if (sameConditions(conditionsAt(state, port), conditions)) return state;
	const between = state.switchCables.find(({ ends }) => ends.some((end) => samePort(end, port)));
	if (between) {
		const { ends, link } = between;
		const changed = { ends, link, ...kept(conditions) };
		return { ...state, switchCables: state.switchCables.map((other) => (other === between ? changed : other)) };
	}
	for (const machine of machineList(state)) {
		const { life } = machine;
		if (life.phase === "failed" || life.phase === "removing") continue;
		const nic = plugsOf(life).findIndex((plug) => plug.kind === "port" && samePort(plug.port, port));
		if (nic < 0) continue;
		const plugs = life.plugs.map((plug, i) => {
			if (i !== nic || plug.kind !== "port") return plug;
			return { kind: plug.kind, port: plug.port, link: plug.link, ...kept(conditions) };
		});
		return { ...state, machines: { ...state.machines, [machine.name]: { ...machine, life: { ...life, plugs } } } };
	}
	return state;
}

export function setConditions(state: LabState, changes: readonly ConditionsChange[]): Step {
	return step(changes.reduce(setOne, state));
}

type Wired = Wiring & Pick<LabState, "switches">;

/** Every port that the cable in it has conditions, on the switches that are there. */
function impaired(state: Wired): readonly ConditionsChange[] {
	return state.switches.flatMap((on) =>
		heldPorts(state, on).flatMap(({ port, conditions }) =>
			hasConditions(conditions) ? [{ port: { switch: on, port }, conditions }] : [],
		),
	);
}

const at = (list: readonly ConditionsChange[], port: PortRef): Conditions =>
	list.find((held) => samePort(held.port, port))?.conditions ?? NO_CONDITIONS;

/**
 * After every change: the switches treat the frames of each port's cable as
 * the lab now has it. A port whose cable went, or went elsewhere, is as a new
 * one, and a switch that is gone takes its ports with it.
 */
export function settleConditions(before: LabState, after: LabState): readonly Effect[] {
	if (before.machines === after.machines && before.switchCables === after.switchCables) return [];
	const was = impaired(before);
	const now = impaired(after);
	if (was.length === 0 && now.length === 0) return [];
	const effects: Effect[] = [];
	for (const { port } of was) {
		if (after.switches.includes(port.switch) && !now.some((held) => samePort(held.port, port))) {
			effects.push({ type: "port/conditions", port, conditions: NO_CONDITIONS });
		}
	}
	for (const { port, conditions } of now) {
		if (!sameConditions(at(was, port), conditions)) effects.push({ type: "port/conditions", port, conditions });
	}
	return effects;
}

/** The effects that give a saved lab's cables their conditions back. */
export function conditionEffects(state: Wired): readonly Effect[] {
	return impaired(state).map(({ port, conditions }) => ({ type: "port/conditions", port, conditions }));
}
