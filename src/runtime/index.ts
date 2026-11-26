// The runtime's public surface. Workers, kernels, the switch and the terminal
// renderer are reachable only through an Engine; vm.ts, fabric.ts and the
// worker protocol are not exported.

export { sweepDisks } from "./disk-stores.ts";
export type { Engine, EngineDeps, ExecOutcome, ExecPort, RuntimeReads, RuntimeStore } from "./engine.ts";
export { createEngine, ExecRefused } from "./engine.ts";
export type { MacEntry, PortCounters } from "./fabric.ts";
export type { DistroManifest } from "./image.ts";
export type { LinkTarget } from "./machine-link.ts";
export type { RuntimeOptions } from "./runtime.ts";
export { createRuntime } from "./runtime.ts";
export type { LineMark, MarkSource, Screen, ScreenIo, Screens, VisibleMark } from "./screens.ts";
export type { ShellEvent, ShellPhase } from "./shell-tracker.ts";
export { BODY_PADDING, ROW_HEIGHT_PX } from "./theme.ts";
