import { DEFAULT_SWITCH, type PortNo, type PortRef } from "../../src/model/index.ts";

/** A port of the switch that every lab has. */
export const port0 = (port: PortNo): PortRef => ({ switch: DEFAULT_SWITCH, port });
