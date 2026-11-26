import "./machine-details.css";
import { html, nothing, type PropertyValues, type TemplateResult } from "lit";
import {
	type Cable,
	type DetailRow,
	droppedWords,
	type LinkWord,
	type MachineDetails,
	type SwitchName,
	selectDetails,
	selectRail,
} from "../../model/index.ts";
import { Select, UnlabElement } from "../base/index.ts";
import { peerPing } from "./peer-ping.ts";

interface CableAction {
	/** Which way it turns the link. */
	readonly to: "up" | "down";
	/** What it reads, for the machine's only cable and for one of several. `into` is a switch to name. */
	readonly only: (into: SwitchName | null) => string;
	readonly one: (nic: string, into: SwitchName | null) => string;
}

const CABLE: Readonly<Record<LinkWord, CableAction>> = {
	up: { only: () => "cut cable", one: (nic) => `cut ${nic}`, to: "down" },
	cut: { only: () => "reconnect", one: (nic) => `reconnect ${nic}`, to: "up" },
	unplugged: {
		only: (into) => (into === null ? "plug in" : `plug into ${into}`),
		one: (nic, into) => (into === null ? `plug in ${nic}` : `plug ${nic} into ${into}`),
		to: "up",
	},
};

/** What the action shows for a machine with no cable to act on yet. */
const NO_CABLE: Cable = { label: "", nic: null, link: "up" };

type Fact = Omit<DetailRow, "label"> & { readonly label: DetailRow["label"] | "frames" };

/**
 * The machine with the keyboard: its name, its facts and its actions. Each
 * action is the command of the same name, so it can fail only the way the bar
 * would.
 */
export class UnlabMachineDetails extends UnlabElement {
	readonly #details = new Select(this, selectDetails);
	readonly #rail = new Select(this, selectRail);
	#unfollow: (() => void) | null = null;

	override connectedCallback(): void {
		super.connectedCallback();
		// Frame counters are the switch's and change without a state change; the capture log ticks with them.
		this.#unfollow = this.app.capture.subscribe(() => this.requestUpdate());
	}

	override disconnectedCallback(): void {
		super.disconnectedCallback();
		this.#unfollow?.();
		this.#unfollow = null;
	}

	protected override willUpdate(changed: PropertyValues<this>): void {
		super.willUpdate(changed);
		this.hidden = this.#details.value === null;
	}

	override render(): TemplateResult | typeof nothing {
		const details = this.#details.value;
		if (!details) return nothing;
		const { name, accepts } = details;
		const cables = details.cables.length > 0 ? details.cables : [NO_CABLE];
		const ping = peerPing(name, this.app.store.state.machines, this.#rail.value);
		return html`<h3 class="name" data-hue=${details.hue}>${name}</h3>
			<dl class="facts">
				${this.#facts(details).map(
					(fact) => html`<div class="fact">
						<dt>${fact.label}</dt>
						<dd data-tone=${fact.tone ?? nothing}>${fact.value}</dd>
					</div>`,
				)}
			</dl>
			${details.reason === null ? nothing : html`<p class="reason">${details.reason}</p>`}
			<div class="actions">
				<button type="button" class="button" ?disabled=${!accepts.commands} @click=${() => this.runLine(`sh ${name}`)}>
					new shell
				</button>
				<button
					type="button"
					class="button"
					?disabled=${!accepts.commands || !ping.line}
					@click=${() => ping.line && this.runLine(ping.line)}
				>
					${ping.label}
				</button>
				${cables.map((cable) => {
					const action = CABLE[cable.link];
					return html`<button
						type="button"
						class="button"
						?disabled=${!accepts.cables || details.cables.length === 0}
						@click=${() => this.runLine(`link ${action.to} ${cable.label}`)}
					>
						${cable.nic === null ? action.only(details.plugsInto) : action.one(cable.nic, details.plugsInto)}
					</button>`;
				})}
				<button type="button" class="button" ?disabled=${!accepts.commands} @click=${() => this.runLine(`reboot ${name}`)}>
					reboot
				</button>
				${
					accepts.boot
						? html`<button type="button" class="button" @click=${() => this.runLine(`boot ${name}`)}>boot</button>`
						: html`<button
								type="button"
								class="button"
								?disabled=${!accepts.commands}
								@click=${() => this.runLine(`poweroff ${name}`)}
							>
								power off
							</button>`
				}
				<button
					type="button"
					class="button danger"
					?disabled=${!accepts.remove}
					@click=${() => this.app.commands.confirmInBar(`rm ${name}`)}
				>
					remove
				</button>
			</div>`;
	}

	#facts(details: MachineDetails): readonly Fact[] {
		const frames = this.#frames(details);
		return details.rows.flatMap((row): Fact[] =>
			row.label === "shells" && frames !== null ? [{ label: "frames", value: frames }, row] : [row],
		);
	}

	/** From the machine's side: `in` is what the switch sent down its cables. Then what those cables dropped, if they did. */
	#frames({ ports }: MachineDetails): string | null {
		const counters = ports.flatMap((port) => this.app.switch.counters(port) ?? []);
		if (counters.length === 0) return null;
		const sum = (of: "txFrames" | "rxFrames") => counters.reduce((n, port) => n + port[of], 0);
		const dropped = droppedWords(ports.flatMap((port) => this.app.switch.carried(port) ?? []));
		return [`${sum("txFrames")} in`, `${sum("rxFrames")} out`, ...(dropped === null ? [] : [dropped])].join(" · ");
	}
}

customElements.define("unlab-machine-details", UnlabMachineDetails);

declare global {
	interface HTMLElementTagNameMap {
		"unlab-machine-details": UnlabMachineDetails;
	}
}
