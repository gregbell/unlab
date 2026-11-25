// The pure lab. Every other layer imports the model from here and nowhere deeper.
//
// One function changes state: `update`, reached only through a store's four
// dispatchers. The pane functions that `update` calls are not exported, so
// nothing else can rearrange panes.

export { type Device, type Disk, disksOf, MAX_EXTRA_DISKS, MAX_EXTRA_GIB, parseGiB } from "./disks.ts";
export {
	identity,
	isNameFault,
	MAX_NAME,
	type NameFault,
	nicLabel,
	nicMac,
	parseChosenName,
	parseMachineName,
	parseSessionId,
	type SessionAddress,
	sessionLabel,
} from "./identity.ts";
export {
	ACCEPTS,
	type Accepts,
	addressOf,
	andList,
	FORCED_STOP,
	firstFreeHues,
	hostsFor,
	isPlanError,
	lowestFreePorts,
	machineList,
	nameBook,
	nicPortsOf,
	nicsOf,
	planBoot,
	planLink,
	planSpawn,
	plugsOf,
	portsOf,
	severalNics,
	takenPorts,
} from "./machines.ts";
export { capacity, gridFor, parkedPanes, visiblePanes } from "./panes.ts";
export * from "./selectors.ts";
export { createStore, type ReadStore, type Schedule, type Store } from "./store.ts";
export { type Tile, type Tiling, tile } from "./tiling.ts";
export * from "./types.ts";
export { clockHz, DEFAULT_POLICIES, initialState, update } from "./update.ts";
export { restoreWorkspace, saveWorkspace } from "./workspace.ts";
