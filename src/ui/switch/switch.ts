import "./switch.css";
import { html, nothing, type TemplateResult } from "lit";
import { type PortView, SWITCH_NAME, selectLinks, selectPorts } from "../../model/index.ts";
import { Select, UnlabElement } from "../base/index.ts";

/** What a click on a port column runs. Empty, booting and removing ports do nothing. */
function clickLine(port: PortView): string | null {
	if (!port.machine) return null;
	if (port.state === "up") return `link down ${port.machine.label}`;
	if (port.state === "cut") return `link up ${port.machine.label}`;
	return null;
}

/**
 * The switch faceplate: a header, then eight equal port columns. `compact`
 * is the dock's size, with a footer note; without it, Wire's, with the way
 * back to the lab in the header. A column whose click does something is one
 * button named by that action, which says the state its face draws; cutting
 * and reconnecting need no confirmation.
 */
export class UnlabSwitch extends UnlabElement {
	static override properties = { compact: { type: Boolean, reflect: true } };
	declare compact: boolean;

	readonly #ports = new Select(this, selectPorts);
	readonly #links = new Select(this, selectLinks);

	constructor() {
		super();
		this.compact = false;
	}

	override render(): TemplateResult {
		const links = this.#links.value;
		return html`<div class="header">
				${this.compact ? nothing : html`<a class="back" href="#lab" @click=${this.#back}>← lab</a>`}
				<span class="title">${SWITCH_NAME}</span>
				<span class="subnet">L2 · 10.88.0.0/24</span>
				<span class="spacer"></span>
				<span class="links" data-cut=${links.cut > 0}>${links.up} of ${links.total} links up</span>
			</div>
			<div class="ports">${this.#ports.value.map((port) => this.#column(port))}</div>
			${this.compact ? html`<p class="note">Click a cable to cut or reconnect it.</p>` : nothing}`;
	}

	#column(port: PortView): TemplateResult {
		const socket = html`<span class="socket">${port.machine ? html`<span class="light"></span>` : nothing}${port.port}</span>`;
		if (!port.machine) return html`<div class="port" data-port=${port.port} data-state="empty">${socket}</div>`;
		const parts = html`<span class="name">${port.machine.name}</span><span class="cable"></span>${
			port.machine.nic === null ? nothing : html`<span class="nic">${port.machine.nic}</span>`
		}${socket}<span class="word"
				>${port.word}</span
			>`;
		const line = clickLine(port);
		const action = line === null ? null : port.actionLabel;
		// The button lies over the whole column with the face beside it, not inside it: its name is
		// the action, and a face inside would make the name disagree with its own visible text.
		return html`<div class="port" data-port=${port.port} data-state=${port.state} data-hue=${port.machine.hue}>
			<span class="face" aria-hidden=${action === null ? nothing : "true"}>${parts}</span>
			${
				line === null || action === null
					? nothing
					: html`<button type="button" class="hit" aria-label=${action} @click=${() => this.runLine(line)}></button>`
			}
		</div>`;
	}

	readonly #back = (event: Event): void => {
		event.preventDefault();
		this.app.store.dispatchUi({ type: "ui/view", view: "lab" });
	};
}

customElements.define("unlab-switch", UnlabSwitch);

declare global {
	interface HTMLElementTagNameMap {
		"unlab-switch": UnlabSwitch;
	}
}
