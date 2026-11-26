// The breaks that `red.mjs` makes: a text in a source file, what it becomes, and the tests that must go red.

const FABRIC = "src/runtime/fabric.ts";
const CONDITIONS = "src/model/conditions.ts";
const WORKSPACE = "src/model/workspace.ts";
const LINK = "src/commands/verbs/link.ts";
const fabricUnit = { kind: "unit", files: ["src/runtime/fabric.test.ts"], grep: "conditions|NIC's cable" };
const modelUnit = { kind: "unit", files: ["src/model/conditions.test.ts"] };
const savedUnit = { kind: "unit", files: ["src/commands/saved-labs.test.ts"] };
const linkUnit = { kind: "unit", files: ["src/commands/verbs/link.test.ts", "src/commands/refusals.test.ts"] };
const topologyUnit = { kind: "unit", files: ["src/commands/verbs/switches.test.ts"], grep: "topology" };
const captureUnit = { kind: "unit", files: ["src/capture/cables.test.ts"], grep: "dropped" };
const detailUnit = { kind: "unit", files: ["src/ui/capture/frame-detail-model.test.ts"], grep: "dropped" };
const faceplate = { kind: "browser", files: ["src/ui/switch/switch.browser.test.ts"], grep: "conditions" };
const kernels = (grep) => ({ kind: "integration", files: ["test/integration/link-conditions.test.ts"], grep });
const e2e = (grep) => ({ kind: "e2e", files: ["e2e/link-conditions.spec.ts"], grep });
const page = { one: e2e("one command"), order: e2e("reordering"), desktop: e2e("desktop") };

export const BREAKS = [
	{
		name: "link takes no notice of its condition options",
		file: LINK,
		from: "if (!clear && Object.keys(values).length === 0) return { ...plan, conditioned: null };",
		to: "if (values) return { ...plan, conditioned: null };",
		tests: [linkUnit, page.one],
	},
	{
		name: "--clear clears nothing",
		file: LINK,
		from: "withConditions(clear ? NO_CONDITIONS : cable.was, values)",
		to: "withConditions(cable.was, values)",
		tests: [linkUnit, page.one],
	},
	{
		name: "a part given as nothing stays",
		file: CONDITIONS,
		from: "if (value === undefined || value === PARTS[part].none) continue;",
		to: "if (value === undefined) continue;",
		tests: [modelUnit, linkUnit],
	},
	{
		name: "reordering needs no delay",
		file: CONDITIONS,
		from: 'if (kept.reorder !== undefined && kept.delay === undefined) return { kind: "reorder-needs-delay" };',
		to: "",
		tests: [modelUnit, linkUnit],
	},
	{
		name: "the switches are not told of a cable's conditions",
		file: "src/model/update.ts",
		from: "...vlans.effects, ...settleConditions(before, state)];",
		to: "...vlans.effects];",
		tests: [modelUnit, linkUnit, page.one],
	},
	{
		name: "a cable between switches has its conditions at one port only",
		file: "src/model/machines.ts",
		from: "...(b.switch === on ? [{ port: b.port, far: a, link, conditions }] : []),",
		to: "...(b.switch === on ? [{ port: b.port, far: a, link, conditions: NO_CONDITIONS }] : []),",
		tests: [modelUnit, linkUnit, page.one],
	},
	{
		name: "a cable that is moved is a new one",
		file: "src/model/machines.ts",
		from: 'old.kind === "port" ? { ...old, port: to } : { kind: "port", port: to, link: "up" };',
		to: '{ kind: "port", port: to, link: old.kind === "port" ? old.link : "up" };',
		tests: [modelUnit],
	},
	{
		name: "a cable that is cut or reconnected is a new one",
		file: "src/model/machines.ts",
		from: 'const cable = plug.kind === "port" ? plug : { kind: "port" as const, port };',
		to: 'const cable = { kind: "port" as const, port };',
		tests: [modelUnit, linkUnit],
	},
	{
		name: "a NIC's cable takes no conditions",
		file: FABRIC,
		from: "if (!sw || !held?.sink || held.out || sw.wear[port] === null) return;",
		to: "if (sw) return;",
		tests: [fabricUnit, kernels("delay"), page.one],
	},
	{
		name: "a NIC's cable has conditions only on the way out of the switch",
		file: FABRIC,
		from: "if (!sw || !src?.up || !dir || (sw.wear[from] === null && dir.waiting === 0)) {",
		to: "if (slot >= 0) {",
		tests: [fabricUnit, kernels("delay"), page.one],
	},
	{
		name: "a cable stays a queue once it has had conditions",
		file: FABRIC,
		from: "if (!dir || (!dir.between && wear === null && dir.waiting === 0)) {",
		to: "if (!dir) {",
		tests: [fabricUnit],
	},
	{
		name: "a change keeps what was on its way waiting",
		file: FABRIC,
		from: "\t\theld.out?.release();\n",
		to: "",
		tests: [fabricUnit],
	},
	{
		name: "a cable holds any number of frames",
		file: FABRIC,
		from: "(wear ? HELD_LIMIT : QUEUE_LIMIT);",
		to: "(wear ? Number.POSITIVE_INFINITY : QUEUE_LIMIT);",
		tests: [fabricUnit],
	},
	{
		name: "a delay holds nothing",
		file: FABRIC,
		from: "dir.skips() < wear.reorder)) due += wear.delay;",
		to: "dir.skips() < wear.reorder)) due += 0;",
		tests: [fabricUnit, kernels("delay"), page.one],
	},
	{
		name: "a cable loses half the share it is given",
		file: FABRIC,
		from: "if (wear.loss > 0 && dir.lost() < wear.loss) {",
		to: "if (wear.loss > 0 && dir.lost() < wear.loss / 2) {",
		tests: [fabricUnit, kernels("loss")],
	},
	{
		name: "a cable loses nothing",
		file: FABRIC,
		from: "if (wear.loss > 0 && dir.lost() < wear.loss) {",
		to: "if (wear.loss > 1) {",
		tests: [fabricUnit, kernels("loss"), page.one, page.desktop],
	},
	{
		name: "no frame skips the delay",
		file: FABRIC,
		from: "!(wear.reorder > 0 && dir.skips() < wear.reorder)",
		to: "!(wear.reorder > 1)",
		tests: [fabricUnit, kernels("reordering"), page.order],
	},
	{
		name: "a frame takes no time at a cable's rate",
		file: FABRIC,
		from: "dir.free = start + frame.length * wear.msPerByte;",
		to: "dir.free = start;",
		tests: [fabricUnit, kernels("rate"), page.order],
	},
	{
		name: "a rate's queue has no bound",
		file: FABRIC,
		from: "if ((start - now) / wear.msPerByte + frame.length > RATE_QUEUE_BYTES) {",
		to: "if (start < 0) {",
		tests: [fabricUnit, kernels("rate"), page.order],
	},
	{
		name: "a cable carries a frame of any length",
		file: FABRIC,
		from: "if (frame.length > wear.longest + (vlanTag(frame) === null ? 0 : TAG_BYTES)) {",
		to: "if (frame.length < 0) {",
		tests: [fabricUnit, kernels("MTU"), page.one],
	},
	{
		name: "a tag counts in a cable's MTU",
		file: FABRIC,
		from: "wear.longest + (vlanTag(frame) === null ? 0 : TAG_BYTES)",
		to: "wear.longest",
		tests: [{ kind: "unit", files: ["src/runtime/fabric.test.ts"], grep: "rest of the fabric" }],
	},
	{
		name: "the Ethernet header counts in a cable's MTU",
		file: FABRIC,
		from: "longest: ETH_HDR + mtu,",
		to: "longest: mtu,",
		tests: [fabricUnit, kernels("MTU"), page.one],
	},
	{
		name: "the tap says nothing of a frame that a cable dropped after the switch sent it",
		file: FABRIC,
		from: 'if (how !== "sent") dropped = [...dropped, { port: p as PortNo, reason: how }];',
		to: "",
		tests: [fabricUnit, kernels("loss"), page.one],
	},
	{
		name: "the tap says nothing of a frame that a machine's cable dropped",
		file: FABRIC,
		from: 'else if (how !== "sent") this.#lost(sw, slot, from, frame, how);',
		to: "",
		tests: [fabricUnit, kernels("MTU"), page.one, page.order],
	},
	{
		name: "a cable counts no loss",
		file: FABRIC,
		from: "\t\t\t\ttally.loss++;\n",
		to: "",
		tests: [fabricUnit, kernels("loss"), page.one, page.desktop],
	},
	{
		name: "a cable counts nothing that it delivered",
		file: FABRIC,
		from: "\t\tsrc.tally.delivered++;\n",
		to: "",
		tests: [fabricUnit, kernels("loss")],
	},
	{
		name: "a row says nothing of a drop",
		file: "src/capture/rows.ts",
		from: "for (const drop of e.dropped) parts.push(dropNote(e, drop, on));",
		to: "",
		tests: [captureUnit, page.one, page.order],
	},
	{
		name: "a row calls every drop loss",
		file: "src/capture/rows.ts",
		from: "${DROP_WORD[reason]}`;",
		to: "${DROP_WORD.loss}`;",
		tests: [captureUnit, page.one, page.order],
	},
	{
		name: "a frame that a machine's cable dropped counts as taken in",
		file: "src/capture/log.ts",
		from: "if (!dropped.some(({ port }) => port === from)) counters.in++;",
		to: "counters.in++;",
		tests: [captureUnit],
	},
	{
		name: "the frame detail says nothing of a drop",
		file: "src/ui/capture/frame-detail-model.ts",
		from: "return [...switched(e, names), ...dropped(e, names)];",
		to: "return switched(e, names);",
		tests: [detailUnit],
	},
	{
		name: "topology has no counts",
		file: "src/commands/verbs/topology.ts",
		from: "const counted = carried(ref) ?? NOTHING_CARRIED;",
		to: "const counted = NOTHING_CARRIED;",
		tests: [topologyUnit, page.one],
	},
	{
		name: "topology says no conditions",
		file: "src/commands/verbs/topology.ts",
		from: "const its = { conditions: writtenConditions(held.conditions), carried };",
		to: "const its = { conditions: {}, carried };",
		tests: [topologyUnit, page.one],
	},
	{
		name: "ls says nothing of a cable's conditions",
		file: "src/commands/verbs/ls.ts",
		from: "...(hasConditions(cable) ? { conditions: writtenConditions(cable) } : {}),",
		to: "",
		tests: [{ kind: "unit", files: ["src/commands/verbs/ls.test.ts"], grep: "conditions" }],
	},
	{
		name: "a port's view has no conditions",
		file: "src/model/selectors.ts",
		from: "return held && hasConditions(held.conditions)\n",
		to: "return held && !held\n",
		tests: [faceplate, page.one, page.desktop],
	},
	{
		name: "the desktop's port table has no Conditions column",
		file: "src/ui/desktop/desktop.ts",
		from: "conditions = ports.some((p) => p.conditions),",
		to: "conditions = false,",
		tests: [page.desktop],
	},
	{
		name: "the map marks no cable",
		file: "src/ui/desktop/topology.ts",
		from: "const marked = impaired ? ` · ${IMPAIRED}` : \"\";",
		to: 'const marked = impaired ? "" : "";',
		tests: [page.desktop],
	},
	{
		name: "a saved lab has no conditions",
		file: WORKSPACE,
		from: '\t\t\t\t\t\tconditions: (plug?.kind === "port" && plug.conditions) || NO_CONDITIONS,',
		to: "\t\t\t\t\t\tconditions: NO_CONDITIONS,",
		tests: [modelUnit, page.one],
	},
	{
		name: "a reload does not tell the switches",
		file: WORKSPACE,
		from: "...vlanEffects(state), ...conditionEffects(state), ...booted.effects];",
		to: "...vlanEffects(state), ...booted.effects];",
		tests: [modelUnit, page.one],
	},
	{
		name: "version 9 is not upgraded",
		file: WORKSPACE,
		from: "\t\t...eachNode((node) => ({ nics: savedNics(node).map((nic) => ({ ...nic, conditions: {} })) }))(lab),",
		to: "\t\t...lab,",
		tests: [savedUnit],
	},
];
