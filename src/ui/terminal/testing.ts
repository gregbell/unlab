// For component tests only: a terminal service that records what the elements
// ask of each screen, and stands in for the screen's keyboard with a textarea.

import type { SessionId } from "../../model/index.ts";
import type { TerminalHost, TerminalService } from "../services.ts";

type Marks = ReturnType<TerminalHost["marks"]>;

export interface FakeHost extends TerminalHost {
	readonly session: SessionId;
	/** Every element the screen was mounted into, in order. */
	readonly mounts: HTMLElement[];
	/** Every `setVisible` and `setFocused` argument, in order. */
	readonly visible: boolean[];
	readonly focused: boolean[];
	/** Where keys would go once mounted. Takes DOM focus on `setFocused(true)`, as the real screen does. */
	readonly input: HTMLTextAreaElement;
	/** Sets what `marks()` answers and fires the render listeners, as a screen does after output. */
	render(marks: Marks): void;
}

export interface FakeTerminals {
	readonly service: TerminalService;
	/** The host for a session, made on first request. */
	host(session: SessionId): FakeHost;
}

export function fakeTerminals(): FakeTerminals {
	const hosts = new Map<SessionId, FakeHost>();
	const make = (session: SessionId): FakeHost => {
		const listeners = new Set<() => void>();
		const input = document.createElement("textarea");
		input.setAttribute("aria-label", `Terminal ${session}`);
		let marks: Marks = [];
		const host: FakeHost = {
			session,
			mounts: [],
			visible: [],
			focused: [],
			input,
			mount(element) {
				host.mounts.push(element);
				element.append(input);
			},
			setVisible(visible) {
				host.visible.push(visible);
			},
			setFocused(focused) {
				host.focused.push(focused);
				if (focused) input.focus();
				else if (document.activeElement === input) input.blur();
			},
			focus: () => input.focus(),
			marks: () => marks,
			onRender(listener) {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			render(next) {
				marks = next;
				for (const listener of [...listeners]) listener();
			},
		};
		return host;
	};
	const host = (session: SessionId): FakeHost => {
		const known = hosts.get(session);
		if (known) return known;
		const made = make(session);
		hosts.set(session, made);
		return made;
	};
	return { service: { host }, host };
}
