import type { AnyVerb } from "../define.ts";
import { boot } from "./boot.ts";
import { capture } from "./capture.ts";
import { exec } from "./exec.ts";
import { focus } from "./focus.ts";
import { link } from "./link.ts";
import { ls } from "./ls.ts";
import { poweroff } from "./poweroff.ts";
import { reboot } from "./reboot.ts";
import { rm } from "./rm.ts";
import { sh } from "./sh.ts";
import { spawn } from "./spawn.ts";

export type { ExecData, ExecRun } from "./exec.ts";
export type { CableState } from "./link.ts";
export type { ListedMachine } from "./ls.ts";
export type { PowerState } from "./power.ts";
export type { RemoveData } from "./rm.ts";
export { DEFAULT_CPUS, MULTICPU_BLOCKER, type SpawnData } from "./spawn.ts";
export { boot, capture, exec, focus, link, ls, poweroff, reboot, rm, sh, spawn };

/** The one verb list, in the order the bar's verbs group shows them. */
export const VERBS: readonly AnyVerb[] = [spawn, rm, ls, exec, sh, link, capture, focus, boot, reboot, poweroff];
