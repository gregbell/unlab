import "./switch.css";
import "./mac-table.ts";
import { html, nothing, type TemplateResult } from "lit";
import {
	carriedWords,
	DEFAULT_SWITCH,
	IMPAIRED,
	type LabState,
	NOTHING_CARRIED,
	type PortView,
	panelLabel,
	selectLinks,
	selectPorts,
	selectStorm,
	selectSubnets,
	treeText,
	treeWord,
} from "../../model/index.ts";
import { Select, UnlabElement, windowButtons } from "../base/index.ts";
import { FollowCapture } from "../capture/follow.ts";

/** What a click on a port column runs. Empty ports, and those of a machine on its way somewhere, do nothing. */
function clickLine(port: PortView): string | null {
	const cable = port.machine?.label ?? port.cable?.label;
	if (cable === undefined) return null;
	if (port.state === "up" || port.state === "off") return `link down ${cable}`;
	if (port.state === "cut") return `link up ${cable}`;
	return null;
}

/** What a per-switch selector has for the switch on the page. */
const shown =
	<T>(select: (on: LabState["shownSwitch"]) => (state: LabState) => T) =>
	(state: LabState): T =>
		select(state.shownSwitch)(state);

/**
 * The switch faceplate: a header, then eight equal port columns. `compact`
 * is the dock's size; without it, the maximised panel's, with the MAC table
 * beside the ports. A column whose click does something is one
 * button named by that action, which says the state its face draws; cutting
 * and reconnecting need no confirmation. In a lab with several switches its
 * title is where one is chosen, and it counts that switch's frames. A cable to
 * another port of a switch is drawn as a machine's is, under that switch's
 * name. While looped frames come into the switch, it says so above its ports,
 * with how many a second and how many it has dropped. A port that the spanning
 * tree keeps out of use says so on its cable's tag.
 */
export class UnlabSwitch extends UnlabElement {
	static override properties = { compact: { type: Boolean, reflect: true } };
	declare compact: boolean;

	readonly #switches = new Select(this, (s) => s.switches);
	readonly #shown = new Select(this, (s) => s.shownSwitch);
	readonly #ports = new Select(this, shown(selectPorts));
	readonly #links = new Select(this, shown(selectLinks));
	readonly #subnets = new Select(this, shown(selectSubnets));
	readonly #storm = new Select(this, shown(selectStorm));
	readonly #storms = new Select(this, (s) => s.storms);

	constructor() {
		super();
		this.compact = false;
		new FollowCapture(this, (capture) => (this.#several || this.#impaired ? capture.revision : 0));
	}

	get #several(): boolean {
		return this.#switches.value.length > 1;
	}

	/** A cable with conditions has its counts in its title, which follow the frames. */
	get #impaired(): boolean {
		return this.#ports.value.some((port) => port.conditions !== undefined);
	}

	override render(): TemplateResult {
		const links = this.#links.value;
		const label = panelLabel(DEFAULT_SWITCH, { switches: this.#switches.value });
		return html`<div class="header">
				${this.#several ? this.#chooser() : html`<span class="title">${DEFAULT_SWITCH}</span>`}
				<span class="subnet">L2 · ${this.#subnets.value}</span>
				<span class="spacer"></span>
				<span class="links" data-cut=${links.cut > 0}>${links.up} of ${links.total} links up</span>
				<span class="window">${windowButtons(label, !this.compact, {
					maximise: () => this.app.store.dispatchUi({ type: "ui/panel-maximised", panel: DEFAULT_SWITCH }),
					park: () => this.app.store.dispatchUi({ type: "ui/panel-parked", panel: DEFAULT_SWITCH }),
				})}</span>
			</div>
			<div class="body">
				<div class="faceplate">
					${this.#stormLine()}
					<div class="ports">${this.#ports.value.map((port) => this.#column(port))}</div>
					<p class="note">Click a cable to cut or reconnect it.</p>
					${this.#several ? this.#counters() : nothing}
				</div>
				${this.compact ? nothing : html`<unlab-mac-table></unlab-mac-table>`}
			</div>`;
	}

	#counters(): TemplateResult {
		const counters = this.app.switch.totals(this.#shown.value);
		return html`<p class="counters">${counters.in} in · ${counters.delivered} delivered · ${counters.flooded} flooded</p>`;
	}

	#stormLine(): TemplateResult | typeof nothing {
		const storm = this.#storm.value;
		if (!storm) return nothing;
		return html`<p class="storm">
			storming · ${storm.rate} looped frames a second · ${storm.dropped} dropped · cut a cable of the loop to end it
		</p>`;
	}

	#chooser(): TemplateResult {
		return html`<select class="field title" aria-label="Switch" @change=${this.#choose}>
			${this.#switches.value.map(
				(name) =>
					html`<option value=${name} .selected=${name === this.#shown.value}>
						${name}${this.#storms.value[name] ? " · storming" : ""}
					</option>`,
			)}
		</select>`;
	}

	readonly #choose = (event: Event): void => {
		if (!(event.currentTarget instanceof HTMLSelectElement)) return;
		const { value } = event.currentTarget;
		const name = this.#switches.value.find((other) => other === value);
		if (name) this.app.store.dispatchUi({ type: "ui/switch-shown", switch: name });
	};

	#column(port: PortView): TemplateResult {
		const socket = html`<span class="socket">${port.machine || port.cable ? html`<span class="light"></span>` : nothing}${port.port}</span>`;
		// A cable to another port of a switch has that switch where a machine's has the machine, and no hue.
		const far = port.cable?.to;
		const held = far
			? { name: far.switch, nic: `port ${far.port}`, label: `to ${far.switch} port ${far.port}`, hue: nothing }
			: port.machine;
		if (!held) return html`<div class="port" data-port=${port.port} data-state="empty">${socket}</div>`;
		// The cable's tag says which NIC it is, what the port carries, that the cable has conditions and that the spanning
		// tree has blocked the port, whichever it needs to.
		const tag = [held.nic, port.vlan?.tag, port.conditions && IMPAIRED, treeWord(port.tree)].filter(Boolean).join(" ");
		const counted = this.app.switch.carried({ switch: this.#shown.value, port: port.port }) ?? NOTHING_CARRIED;
		const carried = port.conditions ? carriedWords(counted) : [];
		const title = [held.label, treeText(port.tree), port.vlan?.text, port.conditions, ...carried]
			.filter(Boolean)
			.join(" · ");
		const parts = html`<span class="name">${held.name}</span><span class="cable"></span>${
			tag === "" ? nothing : html`<span class="nic">${tag}</span>`
		}${socket}<span class="word"
				>${port.word}</span
			>`;
		const line = clickLine(port);
		const action = line === null ? null : port.actionLabel;
		// The button lies over the whole column with the face beside it, not inside it: its name is
		// the action, and a face inside would make the name disagree with its own visible text.
		return html`<div class="port" data-port=${port.port} data-state=${port.state} data-hue=${held.hue} title=${title}>
			<span class="face" aria-hidden=${action === null ? nothing : "true"}>${parts}</span>
			${
				line === null || action === null
					? nothing
					: html`<button type="button" class="hit" aria-label=${action} @click=${() => this.runLine(line)}></button>`
			}
		</div>`;
	}
}

customElements.define("unlab-switch", UnlabSwitch);

declare global {
	interface HTMLElementTagNameMap {
		"unlab-switch": UnlabSwitch;
	}
}
