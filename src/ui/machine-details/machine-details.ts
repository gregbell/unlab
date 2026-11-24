import "./machine-details.css";
import { html, nothing, type PropertyValues, type TemplateResult } from "lit";
import {
	type DetailRow,
	type LinkWord,
	type MachineDetails,
	type MachineName,
	type PortNo,
	selectDetails,
	selectRail,
} from "../../model/index.ts";
import { Select, UnlabElement } from "../base/index.ts";

/** The cable action: what it reads and which way it turns the link. */
const CABLE: Readonly<Record<LinkWord, { readonly label: string; readonly to: "up" | "down" }>> = {
	up: { label: "cut cable", to: "down" },
	cut: { label: "reconnect", to: "up" },
	unplugged: { label: "plug in", to: "up" },
};

type Fact = { readonly label: DetailRow["label"] | "frames"; readonly value: string; readonly tone?: "ok" | "down" };

/**
 * The machine with the keyboard: its name, its facts and four actions. Each
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
		const { name, accepts, link } = details;
		const cable = CABLE[link ?? "up"];
		const peers = this.#rail.value.filter((row) => row.phase === "ready" && row.name !== name).map((row) => row.name);
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
					?disabled=${!accepts.commands || peers.length === 0}
					@click=${() => this.runLine(this.#pingLine(name, peers))}
				>
					${peers.length === 1 ? `Ping ${peers[0]}` : "Ping peers"}
				</button>
				<button
					type="button"
					class="button"
					?disabled=${!accepts.commands || link === null}
					@click=${() => this.runLine(`link ${cable.to} ${name}`)}
				>
					${cable.label}
				</button>
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
		const frames = this.#frames(details.port);
		return details.rows.flatMap((row): Fact[] => {
			const fact = { ...row, tone: toneOf(row, details) };
			return row.label === "shells" && frames !== null ? [{ label: "frames", value: frames }, fact] : [fact];
		});
	}

	/** From the machine's side: `in` is what the switch sent down its cable. */
	#frames(port: PortNo | null): string | null {
		const counters = port === null ? undefined : this.app.switch.counters(port);
		return counters ? `${counters.txFrames} in · ${counters.rxFrames} out` : null;
	}

	#pingLine(name: MachineName, peers: readonly MachineName[]): string {
		const { machines } = this.app.store.state;
		const pings = peers.flatMap((peer) => machines[peer]?.ip ?? []).map((ip) => `ping -c 3 ${ip}`);
		return `exec ${name} -- ${pings.join("; ")}`;
	}
}

function toneOf(row: DetailRow, details: MachineDetails): Fact["tone"] {
	if (row.label === "state" && details.phase === "failed") return "down";
	if (row.label !== "link") return undefined;
	if (details.link === "up") return "ok";
	return details.link === "cut" ? "down" : undefined;
}

customElements.define("unlab-machine-details", UnlabMachineDetails);

declare global {
	interface HTMLElementTagNameMap {
		"unlab-machine-details": UnlabMachineDetails;
	}
}
