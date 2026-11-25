import type { AnyVerb } from "../define.ts";
import { boot } from "./boot.ts";
import { capture } from "./capture.ts";
import { checkpoint } from "./checkpoint.ts";
import { exec } from "./exec.ts";
import { focus } from "./focus.ts";
import { forget } from "./forget.ts";
import { helpFor } from "./help.ts";
import { link } from "./link.ts";
import { ls } from "./ls.ts";
import { mkswitch } from "./mkswitch.ts";
import { plug, unplug } from "./plug.ts";
import { poweroff } from "./poweroff.ts";
import { reboot } from "./reboot.ts";
import { restore } from "./restore.ts";
import { rm } from "./rm.ts";
import { rmswitch } from "./rmswitch.ts";
import { sh } from "./sh.ts";
import { spawn } from "./spawn.ts";
import { topology } from "./topology.ts";
import { write } from "./write.ts";

export type { CheckpointData } from "./checkpoint.ts";
export type { ExecData, ExecRun } from "./exec.ts";
export type { ForgetData } from "./forget.ts";
export type { CableState } from "./link.ts";
export type { ListedMachine } from "./ls.ts";
export type { SwitchData } from "./mkswitch.ts";
export type { PluggedCable } from "./plug.ts";
export type { PowerState } from "./power.ts";
export type { RemoveData } from "./rm.ts";
export type { RemovedSwitch } from "./rmswitch.ts";
export { DEFAULT_CPUS, MULTICPU_BLOCKER, type SpawnData } from "./spawn.ts";
export type { Topology } from "./topology.ts";
export { MAX_TEXT_BYTES, type WriteData } from "./write.ts";
export {
	boot,
	capture,
	checkpoint,
	exec,
	focus,
	forget,
	link,
	ls,
	mkswitch,
	plug,
	poweroff,
	reboot,
	restore,
	rm,
	rmswitch,
	sh,
	spawn,
	topology,
	unplug,
	write,
};

export const help = helpFor(() => VERBS);

/** The one verb list, in the order the bar's verbs group shows them. */
export const VERBS: readonly AnyVerb[] = [
	spawn,
	rm,
	ls,
	exec,
	write,
	sh,
	link,
	plug,
	unplug,
	mkswitch,
	rmswitch,
	topology,
	capture,
	focus,
	boot,
	reboot,
	poweroff,
	checkpoint,
	restore,
	forget,
	help,
];
