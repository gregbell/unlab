import "./machine-details.css";
import { html, nothing, type PropertyValues, type TemplateResult } from "lit";
import {
	type Cable,
	type DetailRow,
	type LinkWord,
	type MachineDetails,
	type MachineName,
	type SwitchName,
	selectDetails,
	selectRail,
} from "../../model/index.ts";
import { ip4str, subnetsOverlap } from "../../net/index.ts";
import { Select, UnlabElement } from "../base/index.ts";

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

interface Peer {
	readonly name: MachineName;
	readonly ip: string;
}

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
		const peers = this.#peers(name);
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
					${peers.length === 1 ? `Ping ${peers[0].name}` : "Ping peers"}
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

	/** From the machine's side: `in` is what the switch sent down its cables. */
	#frames({ ports }: MachineDetails): string | null {
		const counters = ports.flatMap((port) => this.app.switch.counters(port) ?? []);
		if (counters.length === 0) return null;
		const sum = (of: "txFrames" | "rxFrames") => counters.reduce((n, port) => n + port[of], 0);
		return `${sum("txFrames")} in · ${sum("rxFrames")} out`;
	}

	/** The other ready machines that have an address to ping: one this machine shares a subnet with, if there is one. */
	#peers(name: MachineName): readonly Peer[] {
		const { machines } = this.app.store.state;
		const addresses = (of: MachineName) => machines[of]?.spec.nics.flatMap((nic) => nic.address ?? []) ?? [];
		const own = addresses(name);
		return this.#rail.value.flatMap((row) => {
			if (row.phase !== "ready" || row.name === name) return [];
			const theirs = addresses(row.name);
			const address = theirs.find((a) => own.some((mine) => subnetsOverlap(a, mine))) ?? theirs[0];
			return address ? [{ name: row.name, ip: ip4str(address.ip) }] : [];
		});
	}

	#pingLine(name: MachineName, peers: readonly Peer[]): string {
		return `exec ${name} -- ${peers.map(({ ip }) => `ping -c 3 ${ip}`).join("; ")}`;
	}
}

customElements.define("unlab-machine-details", UnlabMachineDetails);

declare global {
	interface HTMLElementTagNameMap {
		"unlab-machine-details": UnlabMachineDetails;
	}
}
