import { PANELS, type PanelName, type Panels } from "./types.ts";

export const ALL_OPEN: Panels = { open: PANELS, maximised: null, putAway: [] };

/** The panels on show, in bar order: the maximised one alone, or every open one. */
export function visiblePanels(p: Panels): readonly PanelName[] {
	return p.maximised ? [p.maximised] : p.open;
}

const inOrder = (names: readonly PanelName[]): readonly PanelName[] => PANELS.filter((name) => names.includes(name));

function shown(p: Panels, name: PanelName): Panels {
	return p.open.includes(name) ? p : { ...p, open: inOrder([...p.open, name]), putAway: [] };
}

/** Parking a panel by hand ends a maximise. */
export function parkPanel(p: Panels, name: PanelName): Panels {
	if (!p.open.includes(name)) return p;
	return { open: p.open.filter((other) => other !== name), maximised: null, putAway: [] };
}

/**
 * A click on a panel's name in the bar shows it, or parks it if it is on show.
 * While a panel is maximised the names act as tabs: another takes its place,
 * and its own brings the panes back.
 */
export function togglePanel(p: Panels, name: PanelName): Panels {
	if (p.maximised) return toggleMaximisedPanel(p, name);
	return p.open.includes(name) ? parkPanel(p, name) : shown(p, name);
}

export function maximisePanel(p: Panels, name: PanelName): Panels {
	return p.maximised === name ? p : { ...shown(p, name), maximised: name };
}

export function toggleMaximisedPanel(p: Panels, name: PanelName): Panels {
	return p.maximised === name ? restorePanels(p) : maximisePanel(p, name);
}

/** Back to the panes with the open panels under them. */
export function restorePanels(p: Panels): Panels {
	return p.maximised ? { ...p, maximised: null } : p;
}

/** Parks every panel, or brings back those it parked; after they were parked one at a time, all of them. */
export function openPanels(p: Panels, open: boolean): Panels {
	if (open === p.open.length > 0) return p;
	if (!open) return { open: [], maximised: null, putAway: p.open };
	return { ...ALL_OPEN, open: p.putAway.length > 0 ? p.putAway : PANELS };
}
