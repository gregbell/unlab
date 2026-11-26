import "./agent-panel.css";
import "../confirm/confirm.ts";
import { html, nothing, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { type AgentCall, type LabState, type Policy, selectAgentIndicator, type ToolName } from "../../model/index.ts";
import { Select, UnlabElement } from "../base/index.ts";
import { hued } from "../confirm/hued.ts";
import { REPO_URL } from "../links.ts";

const POLICIES: readonly { readonly value: Policy; readonly label: string }[] = [
	{ value: "run", label: "run" },
	{ value: "ask", label: "ask me" },
	{ value: "off", label: "off" },
];

/** `first call just now`, `first call 4 min ago`, `first call 2 h ago`. */
function firstCallText(firstCallAt: number | null, now: number): string | null {
	if (firstCallAt === null) return null;
	const minutes = Math.floor(Math.max(0, now - firstCallAt) / 60_000);
	if (minutes < 1) return "first call just now";
	if (minutes < 60) return `first call ${minutes} min ago`;
	return `first call ${Math.floor(minutes / 60)} h ago`;
}

/** `7 run · 1 waiting`: every call that went ahead, then those that wait and those refused. */
function callCount(calls: readonly AgentCall[]): string {
	if (calls.length === 0) return "none yet";
	const n = (...statuses: readonly AgentCall["status"][]) => calls.filter((c) => statuses.includes(c.status)).length;
	const parts = [`${n("running", "done", "failed")} run`];
	if (n("waiting") > 0) parts.push(`${n("waiting")} waiting`);
	if (n("denied") > 0) parts.push(`${n("denied")} denied`);
	return parts.join(" · ");
}

function resultText(call: AgentCall): string {
	switch (call.status) {
		case "running":
		case "waiting":
			return "running…";
		case "aborted":
			return "withdrawn by the agent";
		default:
			return call.result ?? "";
	}
}

/** Browsers block links to their own pages, so a person copies this one. */
const FLAG = "chrome://flags/#enable-webmcp-testing";
const GUIDE = `${REPO_URL}#use-the-lab-with-an-ai-agent`;

const guideLink = html`<a href=${GUIDE} target="_blank" rel="noopener noreferrer">connect an agent</a>`;

function about({ webmcp, paused, calls }: LabState["agent"]): TemplateResult | string {
	if (webmcp.kind === "absent") {
		return html`This tab has no WebMCP, but an agent can call these through the CLI: ${guideLink}. For an agent in
			this browser, open <span class="address">${FLAG}</span> in Chrome or Edge 150 or later, choose Enabled and
			relaunch.`;
	}
	if (webmcp.kind === "refused") {
		return `This browser refused the tools, so an agent may not be able to call them. It said: ${webmcp.message}`;
	}
	if (paused) return "Tools are paused, so an agent in this browser sees none of them until you resume.";
	const ready =
		"An agent in this browser gets the same verbs as the command bar. You decide which ones run without asking.";
	if (calls.length > 0) return ready;
	return html`${ready} To start, ${guideLink}.`;
}

/**
 * What the page exposes over WebMCP, what was called, and what waits for a
 * yes. Policies and pause are UI facts in the store; an answer to a waiting
 * call goes to the agent layer, which mints the approval. No key answers a
 * call: Enter works only on the focused button.
 */
/**
 * How long every approve button stays disabled after the waiting calls
 * change. An agent can add or withdraw calls at will, which moves the blocks;
 * without this, a click aimed at one block could land on another that slid
 * under the pointer.
 */
export const ARM_MS = 600;

export class UnlabAgentPanel extends UnlabElement {
	readonly #agent = new Select(this, (s) => s.agent);
	readonly #indicator = new Select(this, selectAgentIndicator);
	readonly #machines = new Select(this, (s) => s.machines);
	readonly #since = new Select(this, (s) => firstCallText(s.agent.firstCallAt, s.now));
	#waitingIds = "";
	#armed = true;
	/** The waiting calls changed: bring the newest into view once it is drawn. */
	#show = false;
	#arming: ReturnType<typeof setTimeout> | undefined;
	/** What the last press of the setup button came to. */
	#said = "";
	/** The person tried a call that is not in the log yet. */
	#tried = false;

	override disconnectedCallback(): void {
		super.disconnectedCallback();
		clearTimeout(this.#arming);
	}

	#rearm(waiting: readonly { readonly id: number }[]): void {
		const ids = waiting.map((call) => call.id).join(",");
		if (ids === this.#waitingIds) return;
		this.#waitingIds = ids;
		this.#armed = false;
		this.#show = waiting.length > 0;
		clearTimeout(this.#arming);
		this.#arming = setTimeout(() => {
			this.#armed = true;
			this.requestUpdate();
		}, ARM_MS);
	}

	#say(said: string): void {
		this.#said = said;
		this.requestUpdate();
	}

	async #copyFlag(): Promise<void> {
		this.#say("");
		try {
			await navigator.clipboard.writeText(FLAG);
			this.#say("Copied.");
		} catch {
			this.#say("Not copied. Select the address to copy it yourself.");
		}
	}

	async #try(tryCall: () => Promise<void>): Promise<void> {
		this.#tried = true;
		this.#say("");
		try {
			await tryCall();
		} catch (error) {
			this.#tried = false;
			this.#say(`The call did not go through. ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	override updated(): void {
		if (this.#show) {
			this.#show = false;
			// In a narrow window the panel is under everything else.
			void this.#showNewest();
		}
		if (!this.#tried || this.querySelector(".try")) return;
		this.#tried = false;
		// The button under the keyboard went when its call was logged.
		if (document.activeElement === document.body) this.querySelector<HTMLElement>(".calls-head")?.focus();
	}

	async #showNewest(): Promise<void> {
		const newest = [...this.querySelectorAll("unlab-confirm")].at(-1);
		await newest?.updateComplete;
		newest?.scrollIntoView({ block: "nearest" });
	}

	#setup({ webmcp, paused, calls, policies }: LabState["agent"]): TemplateResult | typeof nothing {
		const said = html`<span class="said" role="status">${this.#said}</span>`;
		if (webmcp.kind === "absent") {
			return html`<div class="setup">
				<button type="button" class="button xs" @click=${() => this.#copyFlag()}>copy address</button>${said}
			</div>`;
		}
		const { tryCall } = this.app.agent;
		if (webmcp.kind === "refused" || calls.length > 0 || !tryCall) return nothing;
		return html`<div class="setup">
			<button
				type="button"
				class="button xs try"
				?disabled=${paused || policies.machines_list === "off"}
				@click=${() => this.#try(tryCall)}
			>
				try a call</button
			>${said}
		</div>`;
	}

	override render(): TemplateResult {
		const agent = this.#agent.value;
		const { tools } = this.app.agent;
		const machines = this.#machines.value;
		const status = agent.paused ? "tools paused" : this.#indicator.value;
		const log = agent.calls.filter((call) => call.status !== "waiting");
		const waiting = agent.calls.filter((call) => call.status === "waiting");
		this.#rearm(waiting);
		return html`<div class="head">
				<h2 class="title">webmcp</h2>
				${status === "no agent calls yet" ? nothing : html`<span class="state" data-paused=${String(agent.paused)}>${status}</span>`}
				${this.#since.value ? html`<span class="since">${this.#since.value}</span>` : nothing}
				<span class="spacer"></span>
				<button
					type="button"
					class="button xs"
					@click=${() => this.app.store.dispatchUi({ type: "ui/tools-paused", paused: !agent.paused })}
				>
					${agent.paused ? "resume tools" : "pause tools"}
				</button>
			</div>
			<div class="scroll">
				<p class="about">${about(agent)}</p>
				${this.#setup(agent)}
				<ul class="tools" aria-label="Tools">
					${tools.map((tool) => this.#toolRow(tool.name, tool.args, agent))}
				</ul>
				<h3 class="calls-head" tabindex="-1"><span>calls this session</span><span>${callCount(agent.calls)}</span></h3>
				${
					log.length === 0
						? nothing
						: html`<ol class="log">
							${repeat(
								log,
								(call) => call.id,
								(call) => html`<li class="call" data-status=${call.status}>
									<span class="n">${call.id}</span><span class="line">${hued(call.line, machines)}${call.via === "cli" ? html` <span class="via">via cli</span>` : nothing}</span>
									<span></span><span class="result">→ ${resultText(call)}</span>
								</li>`,
							)}
						</ol>`
				}
			</div>
			${
				waiting.length === 0
					? nothing
					: html`<div class="approvals">
						${repeat(
							waiting,
							(call) => call.id,
							(call) => html`<unlab-confirm
								note=${`${call.id} · ${call.via === "cli" ? "via cli · " : ""}waiting for you`}
								.heading=${call.line}
								.detail=${call.preview ?? ""}
								.actionLabel=${call.actionLabel ?? call.line}
								keep-label="Deny"
								.armed=${this.#armed}
								@unlab-approve=${() => this.app.agent.answer(call.id, true)}
								@unlab-keep=${() => this.app.agent.answer(call.id, false)}
							></unlab-confirm>`,
						)}
					</div>`
			}`;
	}

	#toolRow(name: ToolName, args: readonly string[], agent: LabState["agent"]): TemplateResult {
		const policy = agent.policies[name];
		const exposed = !agent.paused && policy !== "off";
		return html`<li class="tool" data-exposed=${exposed ? "true" : "false"}>
			<span class="name">${name}<span class="args">(${args.join(", ")})</span></span>
			<select
				class="field"
				aria-label=${`Policy for ${name}`}
				@change=${(event: Event) => this.#setPolicy(name, event)}
			>
				${POLICIES.map((p) => html`<option value=${p.value} .selected=${p.value === policy}>${p.label}</option>`)}
			</select>
		</li>`;
	}

	#setPolicy(tool: ToolName, event: Event): void {
		const select = event.target;
		if (!(select instanceof HTMLSelectElement)) return;
		const policy = POLICIES.find((p) => p.value === select.value)?.value;
		if (policy) this.app.store.dispatchUi({ type: "ui/policy", tool, policy });
	}
}

export const AGENT_PANEL_ID = "unlab-agent-panel";

customElements.define("unlab-agent-panel", UnlabAgentPanel);

declare global {
	interface HTMLElementTagNameMap {
		"unlab-agent-panel": UnlabAgentPanel;
	}
}
