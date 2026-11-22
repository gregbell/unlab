import { createContext } from "@lit/context";
import type { AppServices } from "../services.ts";

/** <unlab-app> provides the services; every element below it consumes them. */
export const servicesContext = createContext<AppServices>(Symbol("unlab-services"));
