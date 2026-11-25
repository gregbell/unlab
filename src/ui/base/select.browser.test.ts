import { html, type TemplateResult } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import { selectRail } from "../../model/index.ts";
import { UnlabElement } from "./element.ts";
import { Select } from "./select.ts";
import { lab, mount, ready, spawn, unmountAll } from "./testing.ts";

class SelectProbe extends UnlabElement {
	renders = 0;
	readonly view = new Select(this, (state) => state.view);
	readonly rail = new Select(this, selectRail);

	override render(): TemplateResult {
		this.renders += 1;
		return html`${this.view.value} ${this.rail.value.length}`;
	}
}
customElements.define("unlab-select-probe", SelectProbe);

declare global {
	interface HTMLElementTagNameMap {
		"unlab-select-probe": SelectProbe;
	}
}

afterEach(unmountAll);

describe("Select", () => {
	it("renders the selected values from the store", async () => {
		const { element } = await mount("unlab-select-probe", { state: lab(spawn(2), ready()) });
		expect(element.textContent).toBe("lab 2");
	});

	it("re-renders when a selected value changes", async () => {
		const { element, store, settle } = await mount("unlab-select-probe");
		const before = element.renders;
		store.dispatchUi({ type: "ui/view", view: "spawn" });
		await settle();
		expect(element.renders).toBe(before + 1);
		expect(element.textContent).toBe("spawn 0");
	});

	it("does not re-render for a state change its selectors do not see", async () => {
		const { element, store, settle } = await mount("unlab-select-probe", { state: lab(spawn(2), ready()) });
		const before = element.renders;
		store.dispatchUi({ type: "ui/capture-filter", filter: "arp" });
		await settle();
		expect(store.state.capture.filter).toBe("arp");
		expect(element.renders).toBe(before);
	});

	it("stops listening when disconnected and reads afresh when reconnected", async () => {
		const { element, store, settle } = await mount("unlab-select-probe");
		const parent = element.parentElement;
		element.remove();
		const before = element.renders;
		store.dispatchUi({ type: "ui/view", view: "spawn" });
		expect(element.isUpdatePending).toBe(false);
		expect(element.renders).toBe(before);
		parent?.append(element);
		await settle();
		expect(element.textContent).toBe("spawn 0");
	});
});
