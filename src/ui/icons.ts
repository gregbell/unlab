// Shared line icons for workspace controls.
const paths = {
	machine: '<rect x="3" y="3" width="18" height="13" rx="2"/><path d="M8 21h8m-4-5v5m-5-13 2 2-2 2m4 0h3"/>',
	network:
		'<rect x="9" y="2" width="6" height="5" rx="1"/><path d="M12 7v5M5 16v-4h14v4"/><rect x="2" y="16" width="6" height="5" rx="1"/><rect x="16" y="16" width="6" height="5" rx="1"/>',
	terminal: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m6 9 3 3-3 3m6 0h5"/>',
	pulse: '<path d="M2 12h5l3-8 4 16 3-8h5"/>',
	plus: '<path d="M12 5v14M5 12h14"/>',
	close: '<path d="m6 6 12 12M18 6 6 18"/>',
	search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>',
	pause: '<path d="M8 5v14m8-14v14"/>',
	play: '<path d="m7 4 12 8-12 8z"/>',
	clear: '<path d="M3 6h18M9 6V3h6v3M6 6l1 14h10l1-14m-8 3v7m4-7v7"/>',
	cable: '<path d="m7 3 3 3M3 7l3 3m-2 2 8-8 3 3-2 2a5 5 0 0 1-7 7l-2-2zm9 3 4 4h4"/>',
	send: '<path d="m3 10 18-7-7 18-3-8-8-3zm8 3 5-5"/>',
	panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
	wire: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
} as const;

export function icon(name: keyof typeof paths): string {
	return `<svg class="icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round">${paths[name]}</svg>`;
}
