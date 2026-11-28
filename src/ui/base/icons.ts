import { html } from "lit";

/** A 12px line drawing in the text colour, as the window buttons and narrow toolbars use. */
const line = (
	paths: string,
) => html`<svg class="line-icon" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
	<path d=${paths}></path>
</svg>`;

export const maximiseIcon = line("M1.5 1.5h9v9h-9z");
export const restoreIcon = line("M1.5 3.5h7v7h-7zM4 1.5h6.5v6.5");
export const parkIcon = line("M2 10h8");
export const pauseIcon = line("M4 2v8M8 2v8");
export const resumeIcon = line("M3.5 2v8l6-4z");
export const clearIcon = line("M2 3.5h8M4.5 3.5v-2h3v2M3.2 3.5l.5 7h4.6l.5-7");
export const closeIcon = line("M2 2l8 8M10 2l-8 8");
