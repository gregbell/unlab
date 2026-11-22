// The handoff's terminal theme, in wterm's terms. The handoff lists Catppuccin
// Mocha's 16 colours under xterm.js names with two changes: the cursor is
// --text (rosewater is a machine hue) and the font is the UI font at 12.5px
// over 20px. wterm takes the colours as numbers in ANSI order and everything
// else as custom properties on its element.

import type { TerminalThemeColors } from "@wterm/dom";

/** The handoff's theme block, verbatim. */
export const HANDOFF_THEME = {
	background: "#1e1e2e",
	foreground: "#cdd6f4",
	cursor: "#cdd6f4",
	selectionBackground: "#585b70",
	black: "#45475a",
	brightBlack: "#585b70",
	red: "#f38ba8",
	brightRed: "#f38ba8",
	green: "#a6e3a1",
	brightGreen: "#a6e3a1",
	yellow: "#f9e2af",
	brightYellow: "#f9e2af",
	blue: "#89b4fa",
	brightBlue: "#89b4fa",
	magenta: "#f5c2e7",
	brightMagenta: "#f5c2e7",
	cyan: "#94e2d5",
	brightCyan: "#94e2d5",
	white: "#bac2de",
	brightWhite: "#a6adc8",
} as const;

const rgb = (hex: string): number => Number.parseInt(hex.slice(1), 16);

const T = HANDOFF_THEME;

/** Palette entries 0 to 7 are the normal colours in ANSI order, 8 to 15 their bright forms. */
export const TERMINAL_COLORS: TerminalThemeColors = {
	foreground: rgb(T.foreground),
	background: rgb(T.background),
	cursor: rgb(T.cursor),
	palette: [
		T.black,
		T.red,
		T.green,
		T.yellow,
		T.blue,
		T.magenta,
		T.cyan,
		T.white,
		T.brightBlack,
		T.brightRed,
		T.brightGreen,
		T.brightYellow,
		T.brightBlue,
		T.brightMagenta,
		T.brightCyan,
		T.brightWhite,
	].map(rgb),
};

/** The pane body: 10px above the text, 14px beside it (the gutter the line marks sit in), 12px below. */
export const BODY_PADDING = { top: 10, side: 14, bottom: 12 } as const;
export const ROW_HEIGHT_PX = 20;

/**
 * Set on the screen's own element, where they beat wterm's stylesheet whatever
 * order the page loads its CSS in. The font follows the --font token.
 */
export const TERMINAL_STYLE: Readonly<Record<string, string>> = {
	"--term-selection-bg": T.selectionBackground,
	"--term-font-family": "var(--font, ui-monospace, Menlo, monospace)",
	"--term-font-size": "12.5px",
	"--term-row-height": `${ROW_HEIGHT_PX}px`,
	"--term-line-height": `${ROW_HEIGHT_PX}px`,
	padding: `${BODY_PADDING.top}px ${BODY_PADDING.side}px ${BODY_PADDING.bottom}px`,
	"box-sizing": "border-box",
	width: "100%",
	height: "100%",
	"border-radius": "0",
	"box-shadow": "none",
};
