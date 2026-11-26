import { html, nothing } from "lit";
import { DEFAULT_CPUS, isLineError, MULTICPU_BLOCKER, spawn } from "../../commands/index.ts";
import {
	DEFAULT_SWITCH,
	DISK_SIZES,
	MAX_EXTRA_DISKS,
	MAX_EXTRA_GIB,
	MAX_MACHINES,
	MAX_MEM_MIB,
	PORTS,
	takenPorts,
} from "../../model/index.ts";
import { MAX_NICS } from "../../net/index.ts";
import { Select, UnlabElement } from "../base/index.ts";
import "./machine-wizard.css";

import type { SpawnChoice } from "../spawn-form/form.ts";

const stages = ["Identity", "Compute", "Storage", "Network", "Review"] as const;
type Stage = (typeof stages)[number];
const qty = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

class MachineWizard extends UnlabElement {
	private lab = new Select(this, (state) => state);
	initialChoice?: SpawnChoice;
	private stage: Stage = "Identity";
	private count = 1;
	private name = "";
	private image = "";
	private memory = "256";
	private cpus = String(DEFAULT_CPUS);
	private disk = "4";
	private extras: string[] = [];
	private nics = [{ net: String(DEFAULT_SWITCH), address: "" }];
	private manual = false;
	private gateway = true;
	private running = false;
	private error = "";
	override connectedCallback() {
		super.connectedCallback();
		if (this.initialChoice) {
			const choice = this.initialChoice;
			this.count = choice.count;
			this.image = choice.image;
			this.memory = String(choice.mem);
			this.disk = String(choice.disk);
			this.cpus = String(choice.cpus);
			this.nics = [{ net: choice.net, address: "" }];
		}
		this.image ||= (this.lab.value.images.find((i) => i.name === "alpine") ?? this.lab.value.images[0])?.name ?? "";
	}
	private go(step: Stage) {
		this.stage = step;
		this.error = "";
		this.requestUpdate();
		void this.updateComplete.then(() => {
			this.querySelector(".mw-body")?.scrollTo(0, 0);
			this.querySelector<HTMLElement>(".mw-body h2")?.focus({ preventScroll: true });
		});
	}
	private change(fn: () => void) {
		fn();
		this.error = "";
		this.requestUpdate();
	}
	private input(
		label: string,
		value: string,
		set: (v: string) => void,
		opts: { numeric?: number; disabled?: boolean; placeholder?: string } = {},
	) {
		return html`<label class="mw-field"><span>${label}</span><input class="field" type=${opts.numeric ? "number" : "text"} min=${opts.numeric ? 1 : nothing} max=${opts.numeric ?? nothing} ?required=${!!opts.numeric} .value=${value} ?disabled=${opts.disabled} placeholder=${opts.placeholder ?? ""} @input=${(
			e: Event,
		) => {
			if (e.target instanceof HTMLInputElement) {
				const v = e.target.value;
				this.change(() => set(v));
			}
		}}></label>`;
	}
	private select(label: string, value: string, choices: { value: string; label: string }[], set: (v: string) => void) {
		return html`<label class="mw-field"><span>${label}</span><select class="field" aria-label=${label} @change=${(
			e: Event,
		) => {
			if (e.target instanceof HTMLSelectElement) {
				const v = e.target.value;
				this.change(() => set(v));
			}
		}}>${choices.map((c) => html`<option value=${c.value} .selected=${value === c.value}>${c.label}</option>`)}</select></label>`;
	}
	private identity() {
		const remaining = Math.max(0, MAX_MACHINES - this.lab.value.rail.length);
		return html`<fieldset class="mw-images"><legend>Guest image</legend>${this.lab.value.images.map((i) => html`<label><input type="radio" name="guest-image" .checked=${this.image === i.name} @change=${() => this.change(() => (this.image = i.name))}><span>${i.label}</span></label>`)}</fieldset>
		<div class="mw-grid">${this.select(
			"Machines",
			String(this.count),
			Array.from({ length: Math.max(1, remaining, this.count) }, (_, i) => ({
				value: String(i + 1),
				label: String(i + 1),
			})),
			(v) => (this.count = Number(v)),
		)}
		${this.input("Hostname", this.count === 1 ? this.name : "", (v) => (this.name = v), { disabled: this.count !== 1, placeholder: "Automatic" })}</div>
		<p class="mw-note">${this.count > 1 ? "Each machine gets its own automatic hostname." : `${qty(remaining, "machine slot")} available in this lab.`}</p>`;
	}
	private compute() {
		return html`<div class="mw-grid">${this.input("Virtual CPUs", this.cpus, (v) => (this.cpus = v), { numeric: MULTICPU_BLOCKER ? 1 : 16 })}
		${this.input("Memory (MiB)", this.memory, (v) => (this.memory = v), { numeric: MAX_MEM_MIB })}</div>
		${MULTICPU_BLOCKER ? html`<p class="mw-note">One virtual CPU is available because ${MULTICPU_BLOCKER}.</p>` : nothing}
		${this.count > 1 ? html`<p class="mw-note">Across ${this.count} machines · ${this.count * Number(this.cpus)} vCPU · ${this.count * Number(this.memory)} MiB</p>` : nothing}`;
	}
	private storage() {
		return html`${this.select(
			"Root disk · /dev/wdb",
			this.disk,
			DISK_SIZES.map((v) => ({ value: v, label: `${v} GiB` })),
			(v) => (this.disk = v),
		)}
		<div class="mw-section"><h3>Additional disks</h3><button type="button" class="button" ?disabled=${this.extras.length >= MAX_EXTRA_DISKS} @click=${() => this.change(() => this.extras.push("1"))}>+ Disk</button></div>
		${this.extras.map((v, i) => html`<div class="mw-disk">${this.input(`/dev/wd${String.fromCharCode(99 + i)} (GiB)`, v, (n) => (this.extras[i] = n), { numeric: MAX_EXTRA_GIB })}<button type="button" class="button" aria-label=${`Remove disk ${i + 1}`} @click=${() => this.change(() => this.extras.splice(i, 1))}>Remove</button></div>`)}
		<p class="mw-note">Attach up to ${MAX_EXTRA_DISKS} blank disks, each 1–${MAX_EXTRA_GIB} GiB.</p>`;
	}
	private network() {
		const lab = this.lab.value;
		return html`<div class="mw-section"><h3>Network interfaces</h3><button type="button" class="button" ?disabled=${this.nics.length >= MAX_NICS} @click=${() => this.change(() => this.nics.push({ net: DEFAULT_SWITCH, address: "" }))}>+ Interface</button></div>
		${this.nics.map(
			(
				nic,
				i,
			) => html`<div class="mw-nic"><div class="mw-section"><strong>eth${i}</strong>${i > 0 ? html`<button type="button" class="mw-link" aria-label=${`Remove eth${i}`} @click=${() => this.change(() => this.nics.splice(i, 1))}>Remove</button>` : nothing}</div>
		<div class="mw-grid">${this.select(`Switch for eth${i}`, nic.net, [...lab.switches.map((net) => ({ value: net, label: `${net} · ${PORTS.length - takenPorts(lab, net).size} free` })), { value: "none", label: "Unplugged" }], (v) => (nic.net = v))}
		${this.input(`IPv4 / prefix for eth${i}`, this.manual && this.count === 1 ? nic.address : "", (v) => (nic.address = v), { disabled: !this.manual || this.count > 1, placeholder: !this.manual && i === 0 ? "Lab assigned" : "No address" })}</div></div>`,
		)}
		<label class="mw-check"><input type="checkbox" .checked=${this.manual} @change=${() => this.change(() => (this.manual = !this.manual))}>${this.count === 1 ? "Set interface addresses manually" : "Leave all interfaces without addresses"}</label>
		<label class="mw-check"><input type="checkbox" .checked=${this.gateway && this.nics[0].net !== "none"} ?disabled=${this.nics[0].net === "none"} @change=${() => this.change(() => (this.gateway = !this.gateway))}>Package gateway on eth0</label>`;
	}
	private plan() {
		if (this.manual && this.count === 1 && this.nics.some((n) => n.address.includes(",")))
			return { message: "Enter one IPv4 address and prefix per interface." };
		const line = this.app.commands.registry.command(spawn).tool?.toLine({
			count: this.count,
			image: this.image,
			mem: Number(this.memory),
			cpus: Number(this.cpus),
			disk: this.disk,
			...(this.count === 1 && this.name.trim() ? { name: this.name.trim() } : {}),
			...(this.extras.length ? { extraDisk: this.extras.join(",") } : {}),
			nics: this.nics.length,
			net: this.nics.map((n) => n.net).join(","),
			...(this.manual
				? { addr: this.nics.map((n) => (this.count === 1 && n.address.trim()) || "none").join(",") }
				: {}),
			gateway: this.gateway && this.nics[0].net !== "none" ? "on" : "off",
		});
		if (typeof line !== "string") return line ?? { message: "Machine creation is unavailable." };
		const parsed = this.app.commands.parse(line);
		if (isLineError(parsed)) return parsed;
		const preview = parsed.preview(this.lab.value);
		return isLineError(preview) ? preview : { line: parsed.line, will: preview.will };
	}
	private summary(stage: Stage) {
		switch (stage) {
			case "Identity":
				return `${this.count === 1 ? this.name.trim() || "Automatic hostname" : qty(this.count, "machine")} · ${this.image}`;
			case "Compute":
				return `${this.cpus} vCPU · ${this.memory} MiB`;
			case "Storage":
				return `${this.disk} GiB root${this.extras.length ? ` + ${qty(this.extras.length, "disk")}` : ""}`;
			case "Network":
				return `${qty(this.nics.length, "interface")} · ${this.nics.map((n) => (n.net === "none" ? "unplugged" : n.net)).join(", ")}`;
			case "Review":
				return "";
		}
	}
	private async submit() {
		if (this.running) return;
		if (this.stage !== "Review") {
			const next = stages[stages.indexOf(this.stage) + 1];
			this.go(next);
			return;
		}
		const plan = this.plan();
		if (!("line" in plan)) return;
		this.running = true;
		this.requestUpdate();
		try {
			const result = await this.app.commands.run(plan.line, "button");
			if (isLineError(result)) this.error = result.message;
			else if (result.kind === "failed") this.error = result.error.message;
			else this.app.store.dispatchUi({ type: "ui/view", view: "lab" });
		} catch (e) {
			this.error = e instanceof Error ? e.message : String(e);
		} finally {
			this.running = false;
			this.requestUpdate();
		}
	}
	override render() {
		const i = stages.indexOf(this.stage),
			plan = this.stage === "Review" ? this.plan() : null;
		const title: Record<Stage, string> = {
			Identity: "Choose a guest",
			Compute: "Allocate compute",
			Storage: "Configure disks",
			Network: "Connect interfaces",
			Review: "Review and boot",
		};
		return html`<form class="mw-layout" @submit=${(e: SubmitEvent) => {
			e.preventDefault();
			void this.submit();
		}}>
		<nav class="mw-steps" aria-label="Machine configuration steps">${stages.map((s, n) => html`<button type="button" aria-current=${this.stage === s ? "step" : nothing} @click=${() => this.go(s)}><span aria-hidden="true">${String(n + 1).padStart(2, "0")}</span>${s}</button>`)}</nav>
		<section class="mw-body"><h2 tabindex="-1">${title[this.stage]}</h2>${
			this.stage === "Identity"
				? this.identity()
				: this.stage === "Compute"
					? this.compute()
					: this.stage === "Storage"
						? this.storage()
						: this.stage === "Network"
							? this.network()
							: html`<dl class="mw-review">${stages.slice(0, -1).map((s) => html`<div><dt>${s}</dt><dd>${this.summary(s)}</dd><button type="button" class="mw-link" aria-label=${`Edit ${s}`} @click=${() => this.go(s)}>Edit</button></div>`)}</dl>
		${plan && "line" in plan ? html`<p class="mw-note">${plan.will}</p><details class="mw-command"><summary>Boot command</summary><code>${plan.line}</code></details>` : nothing}`
		}
		${this.error || (plan && "message" in plan) ? html`<p role="alert" class="mw-error">${this.error || (plan && "message" in plan ? plan.message : "")}</p>` : nothing}</section>
		<footer class="mw-footer"><span>${i + 1} / ${stages.length}</span>${i ? html`<button type="button" class="button" @click=${() => this.go(stages[i - 1])}>Back</button>` : nothing}
		<button type="submit" class="button primary" ?disabled=${this.running || !!(plan && "message" in plan)}>${this.stage === "Review" ? (this.running ? "Booting…" : `Boot ${qty(this.count, "machine")}`) : "Continue"}</button></footer></form>`;
	}
}
customElements.define("unlab-machine-wizard", MachineWizard);
