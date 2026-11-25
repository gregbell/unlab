import { UPDATES } from "./updates.ts";

export const SEEN_KEY = "unlab.updates-seen.v1";

/** How many updates came after the last one this browser was shown. Null where it was shown none, or one no longer listed. */
export function unseenUpdates(): number | null {
	const seen = localStorage.getItem(SEEN_KEY);
	const at = UPDATES.findIndex((update) => update.title === seen);
	return at < 0 ? null : at;
}

export function markSeen(): void {
	const newest = UPDATES[0];
	if (newest) localStorage.setItem(SEEN_KEY, newest.title);
}
