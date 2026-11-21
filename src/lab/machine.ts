// A machine as the page sees it: a worker, a port on the switch, a console.

import type { LabSwitch } from "./switch.ts";
import type { FromVm, HostEntry, ToVm, VmConfig } from "./protocol.ts";

export type MachineState = "booting" | "ready" | "exited" | "error";

export interface MachineEvents {
	onChange: () => void;
	onConsole: (bytes: Uint8Array) => void;
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
	/** The host-table version this guest has been given (see Lab#sync). */
	hostsVersion = 0;
	/** The last stage the kernel reported, or the error message. */
	status = "starting";
	bootMs = 0;
	/** Console bytes kept so a terminal can be re-created with its history. */
	readonly scrollback: Uint8Array[] = [];

	readonly #worker: Worker;
	readonly #sw: LabSwitch;
	readonly #events: MachineEvents;
	readonly #pending = new Map<number, (r: { exitCode: number | null; stdout: string; stderr: string }) => void>();
	#nextExecId = 1;
	#scrollbackBytes = 0;

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
				this.#remember(m.bytes);
				this.#events.onConsole(m.bytes);
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
		}
	}

	#remember(bytes: Uint8Array): void {
		this.scrollback.push(bytes);
		this.#scrollbackBytes += bytes.length;
		// Enough to redraw a terminal, not enough to grow without bound.
		while (this.#scrollbackBytes > 256 * 1024 && this.scrollback.length > 1) {
			this.#scrollbackBytes -= this.scrollback.shift()!.length;
		}
	}

	write(data: string): void {
		this.#send({ type: "input", data });
	}

	resize(cols: number, rows: number): void {
		this.#send({ type: "resize", cols, rows });
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

	/** Power off and drop the thread. */
	destroy(): void {
		this.#send({ type: "stop" });
		this.#sw.removePort(this.id);
		// The kernel blocks its thread while idle, so a clean stop may never be
		// observed: terminate shortly after asking.
		setTimeout(() => this.#worker.terminate(), 250);
	}
}
