import { PANELS, type PanelName, type Panels } from "./types.ts";

export const ALL_OPEN: Panels = { open: PANELS, maximised: null };

/** The panels on show, in bar order: the maximised one alone, or every open one. */
export function visiblePanels(p: Panels): readonly PanelName[] {
	return p.maximised ? [p.maximised] : p.open;
}

/** The panels put away, in bar order. One that a maximised panel covers is not parked. */
export function parkedPanels(p: Panels): readonly PanelName[] {
	return PANELS.filter((name) => !p.open.includes(name));
}

const withOpen = (open: readonly PanelName[], name: PanelName): readonly PanelName[] =>
	open.includes(name) ? open : PANELS.filter((other) => other === name || open.includes(other));

/** Parking a panel by hand ends a maximise. */
export function parkPanel(p: Panels, name: PanelName): Panels {
	if (!p.open.includes(name)) return p;
	return { open: p.open.filter((other) => other !== name), maximised: null };
}

/** Bringing a parked panel back ends a maximise, so it comes back beside the others. */
export function unparkPanel(p: Panels, name: PanelName): Panels {
	if (p.open.includes(name)) return p;
	return { open: withOpen(p.open, name), maximised: null };
}

export function maximisePanel(p: Panels, name: PanelName): Panels {
	return p.maximised === name ? p : { open: withOpen(p.open, name), maximised: name };
}

export function toggleMaximisedPanel(p: Panels, name: PanelName): Panels {
	return p.maximised === name ? restorePanels(p) : maximisePanel(p, name);
}

/** Back to the panes with the open panels under them. */
export function restorePanels(p: Panels): Panels {
	return p.maximised ? { ...p, maximised: null } : p;
}
