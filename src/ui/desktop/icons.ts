import { html } from "lit";

const paths = {
	more: "M4 12a1 1 0 1 0 2 0a1 1 0 1 0-2 0m7 0a1 1 0 1 0 2 0a1 1 0 1 0-2 0m7 0a1 1 0 1 0 2 0a1 1 0 1 0-2 0",
	power: "M12 2v9 M7 5a8 8 0 1 0 10 0",
	reboot: "M4 5v6h6 M4.5 10a8 8 0 1 1 .7 7",
	trash: "M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7",
	about: "M12 2.5a9.5 9.5 0 1 0 .01 0z M12 10v6 M12 7v.2",
	ssh: "M3 5h18v14H3z M7 9l3 3-3 3m6 0h4",
	rack: "M3 3h18v7H3z M3 14h18v7H3z M6 6.5h1m2 0h1M6 17.5h1m2 0h1",
	console: "M3 5h18v14H3z M6 9l3 3-3 3m6 0h4",
	capture: "M2 12h5l3-8 4 16 3-10 2 2h3",
	note: "M5 3h14v15l-3 3H5z M8 8h8M8 12h8m-8 4h4",
	machine: "M3 4h18v13H3z M8 21h8m-4-4v4",
	switch: "M2 7h20v10H2z M6 11v2m4-2v2m4-2v2m4-2v2",
	patch: "M4 4v3c0 9 16-1 16 9v4 M2 3h4m12 18h4",
	agent: "M5 6h14v13H5z M12 3v3M8 11h1m6 0h1m-7 5h6",
	cpu: "M6 6h12v12H6z M9 2v4m6-4v4m-6 12v4m6-4v4M2 9h4m-4 6h4m12-6h4m-4 6h4",
	memory: "M2 7h20v9H2z M6 10v3m4-3v3m4-3v3m4-3v3M5 16v3m4-3v3m6-3v3m4-3v3",
	network: "M3 9h6v6H3z M15 3h6v6h-6z M15 15h6v6h-6z M9 12h3m3-6h-3v12h3",
	chevron: "m8 10 4 4 4-4",
	plus: "M12 5v14m-7-7h14",
};
export type Icon = keyof typeof paths;
export const icon = (kind: Icon) =>
	html`<svg class="dt-icon" viewBox="0 0 24 24" aria-hidden="true"><path d=${paths[kind]}></path></svg>`;
export const launcherMark = html`<svg class="dt-launch-mark" viewBox="0 0 32 32" fill="none" aria-hidden="true"><path class="dt-cord" d="M7 12v5a9 9 0 0 0 18 0v-5"/><g class="dt-plugs"><path d="M4 4h6v6l-1 2H5l-1-2z M22 4h6v6l-1 2h-4l-1-2z"/><path d="M4.5 8h5m13 0h5"/></g></svg>`;
