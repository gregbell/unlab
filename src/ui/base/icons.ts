import { html } from "lit";

export const plusIcon = html`<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
	<path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"></path>
</svg>`;

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
export const upIcon = line("M2.5 8l3.5-4 3.5 4");

/** A 14px brand mark in the text colour, drawn in a square `size` wide. */
const mark = (
	size: number,
	path: string,
) => html`<svg width="14" height="14" viewBox="0 0 ${size} ${size}" fill="currentColor" aria-hidden="true" focusable="false">
	<path d=${path}></path>
</svg>`;

export const githubMark = mark(
	16,
	"M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z",
);
export const xMark = mark(
	24,
	"M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z",
);
