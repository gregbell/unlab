// The pure lab. Every other layer imports the model from here and nowhere deeper.
//
// One function changes state: `update`, reached only through a store's five
// dispatchers. The pane functions that `update` calls are not exported, so
// nothing else can rearrange panes.

export { cableAt, cablesOf, cableText, endsFrom, isCablePlanError, joined, planCable } from "./cables.ts";
export {
	CONDITION_PARTS,
	type ConditionsFault,
	type ConditionValues,
	carriedWords,
	conditionsAt,
	conditionsOf,
	conditionWords,
	DROP_WORD,
	droppedWords,
	ETH_MTU,
	hasConditions,
	isConditionsFault,
	MAX_DELAY_MS,
	MAX_RATE,
	MIN_MTU,
	MIN_RATE,
	NOTHING_CARRIED,
	parseCondition,
	sameConditions,
	type WrittenConditions,
	withConditions,
	writeCondition,
	writtenConditions,
} from "./conditions.ts";
export { type Device, type Disk, disksOf, MAX_EXTRA_DISKS, MAX_EXTRA_GIB, parseGiB, sizeText } from "./disks.ts";
export {
	identity,
	isNameFault,
	MAX_NAME,
	type NameFault,
	nicLabel,
	nicMac,
	parseCheckpointName,
	parseChosenName,
	parseMachineName,
	parseSessionId,
	parseSwitchName,
	type SessionAddress,
	sessionLabel,
} from "./identity.ts";
export {
	ACCEPTS,
	type Accepts,
	addressOf,
	andList,
	FORCED_STOP,
	type HeldPort,
	heldPorts,
	holdsNic,
	hostsFor,
	isPlanError,
	lowestFreePorts,
	machineList,
	memoryGiven,
	type NicPort,
	nameBook,
	nicPorts,
	nicPortsOf,
	nicsOf,
	planBoot,
	planLink,
	planPlug,
	planRestore,
	planSpawn,
	plugsOf,
	portsOf,
	samePort,
	savingOf,
	severalNics,
	takenPorts,
} from "./machines.ts";
export { type LearnedMac, type MacRow, macRows, macSeen, type SwitchTotals, totalsText } from "./macs.ts";
export { capacity, gridFor, visiblePanes } from "./panes.ts";
export * from "./selectors.ts";
export { createStore, type ReadStore, type Schedule, type Store } from "./store.ts";
export {
	BLOCKED,
	bridgeText,
	costOf,
	parseCost,
	parsePriority,
	priorityOf,
	rootOf,
	stpOn,
	treePortAt,
	treeRoleText,
	treeSummary,
	treeWord,
} from "./stp.ts";
export { planSwitch, portLabel, portName, portText, switchLabel } from "./switches.ts";
export * from "./types.ts";
export { clockHz, DEFAULT_POLICIES, initialState, update } from "./update.ts";
export { carries, parseVlanId, sameVlan, vlanList, vlanOf, vlanText } from "./vlans.ts";
export { restoreWorkspace, saveWorkspace } from "./workspace.ts";
