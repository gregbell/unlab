// A machine as the page sees it: a worker, a port on the switch, and the
// terminal sessions open on it.
//
// Every machine has one console (the kernel's own, which carries the boot log)
// and any number of shells, each on its own pty in the guest. A tab is a view
// of one session, so several tabs can watch the same machine.

import type { FromVm, HostEntry, ToVm, VmConfig } from "./protocol.ts";
import type { LabSwitch } from "./switch.ts";

export type MachineState = "booting" | "ready" | "exited" | "error";
export type SessionKind = "console" | "shell";
export type SessionState = "opening" | "open" | "closed";

export interface MachineEvents {
	onChange: () => void;
}

/** Bytes kept per session so a terminal can be rebuilt with its history. */
const SCROLLBACK_BYTES = 256 * 1024;

export class Session {
	readonly id: string;
	readonly machine: Machine;
	readonly kind: SessionKind;
	/** Shells are numbered per machine: the first is "shell", then "shell 2". */
	readonly label: string;
	state: SessionState;
	/** /dev/pts/N once the guest has opened it. */
	detail = "";
	readonly scrollback: Uint8Array[] = [];
	#bytes = 0;
	readonly #listeners = new Set<(bytes: Uint8Array) => void>();
	cols = 100;
	rows = 30;

	constructor(machine: Machine, kind: SessionKind, id: string, label: string) {
		this.machine = machine;
		this.kind = kind;
		this.id = id;
		this.label = label;
		this.state = kind === "console" ? "open" : "opening";
	}

	get title(): string {
		return `${this.machine.name} · ${this.label}`;
	}

	/** @internal Output from the guest. */
	emit(bytes: Uint8Array): void {
		this.scrollback.push(bytes);
		this.#bytes += bytes.length;
		while (this.#bytes > SCROLLBACK_BYTES && this.scrollback.length > 1) {
			this.#bytes -= this.scrollback.shift()!.length;
		}
		for (const fn of this.#listeners) fn(bytes);
	}

	onData(fn: (bytes: Uint8Array) => void): () => void {
		this.#listeners.add(fn);
		return () => this.#listeners.delete(fn);
	}

	write(data: string): void {
		this.machine.sessionWrite(this, data);
	}

	resize(cols: number, rows: number): void {
		if (cols === this.cols && rows === this.rows) return;
		this.cols = cols;
		this.rows = rows;
		this.machine.sessionResize(this, cols, rows);
	}

	close(): void {
		this.machine.closeSession(this);
	}
}

export class Machine {
	readonly id: string;
	readonly mac: string;
	name: string;
	ip: string;
	readonly distro: string;
	readonly memoryMiB: number;
	internet: boolean;

	state: MachineState = "booting";
	/** The last stage the kernel reported, or the error message. */
	status = "starting";
	bootMs = 0;
	/** The host-table version this guest has been given (see Lab#sync). */
	hostsVersion = 0;

	readonly sessions: Session[] = [];
	readonly console: Session;

	readonly #worker: Worker;
	readonly #sw: LabSwitch;
	readonly #events: MachineEvents;
	readonly #pending = new Map<number, (r: { exitCode: number | null; stdout: string; stderr: string }) => void>();
	/** Shells by the session id the worker knows them as. */
	readonly #ptys = new Map<number, Session>();
	#nextExecId = 1;
	#nextSid = 1;
	#shellCount = 0;

	constructor(cfg: Omit<VmConfig, "image">, image: Promise<ArrayBufferLike>, sw: LabSwitch, events: MachineEvents) {
		this.id = cfg.id;
		this.name = cfg.name;
		this.ip = cfg.ip;
		this.mac = cfg.mac;
		this.distro = cfg.distro;
		this.memoryMiB = cfg.memoryMiB;
		this.internet = cfg.internet;
		this.#sw = sw;
		this.#events = events;

		this.console = new Session(this, "console", `${this.id}:console`, "console");
		this.sessions.push(this.console);

		// The new URL(...) must sit inside the new Worker(...) call: that literal
		// form is what the bundler recognises, and anything else ships the
		// worker as an unprocessed source file.
		this.#worker = new Worker(new URL("../vm-worker.ts", import.meta.url), { type: "module", name: `unlab:${cfg.name}` });
		this.#worker.addEventListener("message", (ev: MessageEvent<FromVm>) => this.#onMessage(ev.data));
		this.#worker.addEventListener("error", (ev) => {
			this.state = "error";
			this.status = ev.message || "worker failed";
			this.#events.onChange();
		});

		sw.addPort(this.id, {
			name: cfg.name,
			deliver: (frame) => {
				// The switch shares one frame with every port of a flood, so the
				// bytes must be copied before the buffer is transferred away.
				const copy = frame.slice();
				this.#send({ type: "frame", frame: copy }, [copy.buffer]);
			},
		});

		// The image is fetched once for the whole lab; boot as soon as it is here.
		this.status = "fetching image";
		void image.then(
			(buf) => this.#send({ type: "boot", cfg: { ...cfg, image: buf } }),
			(e: unknown) => {
				this.state = "error";
				this.status = e instanceof Error ? e.message : String(e);
				this.#events.onChange();
			},
		);
	}

	#send(m: ToVm, transfer: Transferable[] = []): void {
		this.#worker.postMessage(m, transfer);
	}

	#onMessage(m: FromVm): void {
		switch (m.type) {
			case "frame":
				this.#sw.receive(this.id, m.frame);
				return;
			case "console":
				this.console.emit(m.bytes);
				return;
			case "stage":
				if (m.stage !== "log") this.status = m.stage;
				this.#events.onChange();
				return;
			case "booted":
				this.status = "configuring";
				this.bootMs = m.ms;
				this.#events.onChange();
				return;
			case "ready":
				this.state = "ready";
				this.status = "up";
				this.bootMs = m.ms;
				this.#events.onChange();
				return;
			case "exited":
				this.state = "exited";
				this.status = m.reason || `exit ${m.code}`;
				for (const s of this.sessions) s.state = "closed";
				this.#sw.setLink(this.id, false);
				this.#events.onChange();
				return;
			case "error":
				if (m.fatal) this.state = "error";
				this.status = m.message;
				this.#events.onChange();
				return;
			case "exec-result": {
				const r = this.#pending.get(m.id);
				this.#pending.delete(m.id);
				r?.({ exitCode: m.exitCode, stdout: m.stdout, stderr: m.stderr });
				return;
			}
			case "pty-ready": {
				const s = this.#ptys.get(m.sid);
				if (!s) return;
				s.state = "open";
				s.detail = `pts/${m.pts} · pid ${m.pid}`;
				this.#events.onChange();
				return;
			}
			case "pty-output":
				this.#ptys.get(m.sid)?.emit(m.bytes);
				return;
			case "pty-exit": {
				const s = this.#ptys.get(m.sid);
				if (!s) return;
				s.state = "closed";
				if (m.reason) s.detail = m.reason;
				this.#ptys.delete(m.sid);
				this.#events.onChange();
				return;
			}
		}
	}

	/** Open another shell on this machine, on its own pty. */
	openShell(cols = 100, rows = 30): Session {
		const sid = this.#nextSid++;
		this.#shellCount++;
		const label = this.#shellCount === 1 ? "shell" : `shell ${this.#shellCount}`;
		const s = new Session(this, "shell", `${this.id}:pty${sid}`, label);
		s.cols = cols;
		s.rows = rows;
		this.#ptys.set(sid, s);
		this.sessions.push(s);
		this.#send({ type: "pty-open", spec: { sid, cols, rows } });
		this.#events.onChange();
		return s;
	}

	/** @internal */
	sessionWrite(s: Session, data: string): void {
		if (s.kind === "console") {
			this.#send({ type: "input", data });
			return;
		}
		const sid = this.#sidOf(s);
		if (sid !== undefined) this.#send({ type: "pty-data", sid, data });
	}

	/** @internal */
	sessionResize(s: Session, cols: number, rows: number): void {
		if (s.kind === "console") {
			this.#send({ type: "resize", cols, rows });
			return;
		}
		const sid = this.#sidOf(s);
		if (sid !== undefined) this.#send({ type: "pty-resize", sid, cols, rows });
	}

	/** The console cannot be closed; it belongs to the machine. */
	closeSession(s: Session): void {
		if (s.kind === "console") return;
		const sid = this.#sidOf(s);
		if (sid !== undefined) {
			this.#send({ type: "pty-close", sid });
			this.#ptys.delete(sid);
		}
		const i = this.sessions.indexOf(s);
		if (i >= 0) this.sessions.splice(i, 1);
		s.state = "closed";
		this.#events.onChange();
	}

	#sidOf(s: Session): number | undefined {
		for (const [sid, sess] of this.#ptys) if (sess === s) return sid;
		return undefined;
	}

	exec(cmd: string, root = false): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
		const id = this.#nextExecId++;
		return new Promise((resolve) => {
			this.#pending.set(id, resolve);
			this.#send({ type: "exec", id, cmd, root });
		});
	}

	/** Push a new name, address or host table into the running guest. */
	reconfigure(hosts: HostEntry[], prefixBits: number): void {
		if (this.state !== "ready") return;
		this.#send({ type: "reconfigure", name: this.name, ip: this.ip, prefixBits, hosts, internet: this.internet });
	}

	get link(): boolean {
		return this.#sw.isUp(this.id);
	}

	setLink(up: boolean): void {
		this.#sw.setLink(this.id, up);
		this.#events.onChange();
	}

	counters(): ReturnType<LabSwitch["counters"]> {
		return this.#sw.counters(this.id);
	}

	/** Power off and drop the thread. */
	destroy(): void {
		this.#send({ type: "stop" });
		this.#sw.removePort(this.id);
		// The kernel blocks its thread while idle, so a clean stop may never be
		// observed: terminate shortly after asking.
		setTimeout(() => this.#worker.terminate(), 250);
	}
}
