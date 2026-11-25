// The rows and blocks of the open panel, as templates over the bar's view.
// The element owns the events; these only draw.

import { html, nothing, type TemplateResult } from "lit";
import { type ReportBlock, tokenize } from "../../commands/index.ts";
import type { LabState, SessionId } from "../../model/index.ts";
import { hued } from "../confirm/hued.ts";
import type { BarBlock, BarRow, Signature } from "./model.ts";

type Machines = LabState["machines"];

/** `you · 2 min ago`, from the lab clock. */
function ago(at: number, now: number): string {
	const minutes = Math.floor(Math.max(0, now - at) / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} min ago`;
	return `${Math.floor(minutes / 60)} h ago`;
}

export function rowContent(row: BarRow, lab: LabState): TemplateResult {
	switch (row.kind) {
		case "recent": {
			const who = row.source === "agent" || row.source === "cli" ? row.source : "you";
			return html`<span class="line">${hued(row.line, lab.machines)}</span>
				<span class="who">${who} · ${ago(row.at, lab.now)}</span>`;
		}
		case "verb":
			return html`<span class="verb">${row.name}</span>
				<span class="parts">${row.signature}</span>
				<span class="note">${row.about}</span>`;
		case "value": {
			const { label, detail, hue } = row.suggestion;
			return html`<span class="value" title=${label} data-hue=${hue ?? nothing}>${label}</span>
				${detail === undefined ? nothing : html`<span class="note">${detail}</span>`}`;
		}
		case "fix":
			return html`<span class="line">${hued(row.line, lab.machines)}</span>
				${row.will === null ? nothing : html`<span class="note">${row.will}</span>`}`;
	}
}

/** The verb and its arguments, with the one under the cursor lit and underlined. */
export function signatureRow(signature: Signature | null): TemplateResult | typeof nothing {
	if (signature === null) return nothing;
	const parts = signature.parts.map(
		(part, i) => html` <span class=${i === signature.current ? "current" : ""}>${part}</span>`,
	);
	return html`<div class="signature">${signature.verb}${parts}</div>`;
}

/** The preview and the running line, read out politely as they change. */
export function politeBlock(block: BarBlock, lab: LabState): TemplateResult | typeof nothing {
	switch (block.kind) {
		case "preview": {
			const { will, assumed, tone } = block.preview;
			return html`<div class="preview" data-tone=${tone}>
				<span class="label">will</span><span class="will">${hued(will, lab.machines)}</span>
				${assumed === null ? nothing : html`<span class="assumed">${assumed}</span>`}
			</div>`;
		}
		case "running":
			return html`<div class="running"><span class="label">running</span><span>${block.line}</span></div>`;
		default:
			return nothing;
	}
}

/** The line echoed with the offending token in --down and carets under it, then the sentence. */
export function errorBlock(block: Extract<BarBlock, { kind: "error" }>): TemplateResult {
	const { line, mark, sentence, nothingChanged } = block;
	const echo =
		mark === null
			? html`<div>${line}</div>`
			: html`<div>${line.slice(0, mark.start)}<span class="bad">${line.slice(mark.start, mark.end)}</span>${line.slice(mark.end)}</div>
					<div class="carets" aria-hidden="true">${" ".repeat(mark.start)}${"^".repeat(Math.max(1, mark.end - mark.start))}</div>`;
	return html`<div class="error" role="alert">
		<div class="echo">${echo}</div>
		<p class="sentence">${sentence}</p>
		${nothingChanged ? html`<p class="unchanged">Nothing was changed.</p>` : nothing}
	</div>`;
}

const ran = (b: ReportBlock): boolean => b.status.kind === "exit" || b.status.kind === "unknown";

function status(block: ReportBlock): TemplateResult {
	switch (block.status.kind) {
		case "exit":
			return html`<span class="status" data-ok=${block.status.code === 0}>exit ${block.status.code}</span>`;
		case "unknown":
			return html`<span class="status">exit ?</span>`;
		case "state":
			return html`<span class="status" data-state=${block.status.text}>${block.status.text}</span>`;
		case "skipped":
			return html`<span class="status">${block.status.reason}</span>`;
	}
}

/** `ran in 3 consoles in 1.0 s · 2 failed`, with the failures in --down. */
function header(text: string): TemplateResult[] {
	return text.split(" · ").map((part, i) => {
		const sep = i === 0 ? "" : " · ";
		return /\bfailed$/.test(part) ? html`${sep}<span class="failed">${part}</span>` : html`${sep}${part}`;
	});
}

/** For `exec all -- …`: what `all` stood for, when the line did not name the machines itself. */
function expansion(line: string, blocks: readonly ReportBlock[], machines: Machines): TemplateResult | typeof nothing {
	const [verb, targets] = tokenize(line).tokens;
	const names = blocks.filter(ran).map((b) => b.machine);
	if (verb?.text !== "exec" || !targets || names.length === 0 || targets.text === names.join(",")) return nothing;
	return html`<span class="expansion"
		><span class="label">${targets.text} =</span>${names.map((name) => html` ${hued(name, machines)}`)}</span
	>`;
}

/**
 * A summary line and what there is to read: one block per machine with its
 * hue bar for exec and ls, or rows of terms for help. Then what was skipped
 * and why.
 */
export function resultBlock(
	block: Extract<BarBlock, { kind: "result" }>,
	lab: LabState,
	openConsole: (session: SessionId) => void,
): TemplateResult {
	const shown = block.blocks.filter((b) => b.status.kind !== "skipped");
	const skipped = block.blocks.filter((b) => b.status.kind === "skipped");
	const fanout = shown.some(ran);
	return html`<div class="result">
		<div class="summary">
			${expansion(block.line, block.blocks, lab.machines)}
			<span class="header">${header(block.header)}</span>
		</div>
		${
			block.rows.length === 0
				? nothing
				: html`<dl class="rows">
					${block.rows.map(({ term, text }) => html`<dt>${term}</dt><dd>${text}</dd>`)}
				</dl>`
		}
		${shown.map(
			(b) => html`<div class="machine-result" data-hue=${b.hue}>
				<div class="top">
					<span class="name">${b.machine}</span>${status(b)}
					${
						b.focus === null
							? nothing
							: html`<a
									class="open-console"
									href=${`#panel-${b.focus.replace(":", "-")}`}
									aria-label=${`open console, ${b.machine}`}
									@click=${(event: Event) => {
										event.preventDefault();
										if (b.focus !== null) openConsole(b.focus);
									}}
									>open console</a
								>`
					}
				</div>
				${b.lastLine === "" ? nothing : html`<div class="last">${b.lastLine}</div>`}
			</div>`,
		)}
		${
			skipped.length === 0
				? nothing
				: html`<div class="skipped">
					<span class="label">skipped</span>
					${skipped.map((b) => html`<span data-hue=${b.hue}><span class="name">${b.machine}</span> ${status(b)}</span>`)}
				</div>`
		}
		${
			fanout
				? html`<p class="footnote">
					Showing the last line from each. The full output is in each console, marked as sent from here.
				</p>`
				: nothing
		}
	</div>`;
}
