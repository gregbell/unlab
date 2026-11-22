// The lab: one layer-2 segment, a machine on each port, and the bookkeeping
// that keeps names and addresses agreeing across every guest.

import { PORTS } from "../model/types.ts";
import { labMac, Subnet } from "../net/index.ts";
import { LabSwitch } from "../runtime/switch.ts";
import { loadImage } from "./image.ts";
import { Machine } from "./machine.ts";
import type { HostEntry, VmConfig } from "./protocol.ts";

export interface DistroManifest {
	unkernel: string;
	release: string;
	distros: Array<{ name: string; file: string; size: number; sha256: string; image: string }>;
}

export interface AddOptions {
	name?: string;
	/** A distro name from the manifest, e.g. "alpine". */
	distro?: string;
	internet?: boolean;
	memoryMiB?: number;
	/** Fix the host part of the address instead of taking the next free one. */
	hostNum?: number;
}

export interface LabOptions {
	cidr?: string;
	manifest: DistroManifest;
	wispServers?: string[];
	onChange: () => void;
}

/** Addresses below this are left for the gateway and future fixtures. */
const FIRST_HOST = 11;

export class Lab {
	readonly sw = new LabSwitch();
	readonly subnet: Subnet;
	readonly manifest: DistroManifest;
	readonly machines: Machine[] = [];
	readonly #opts: LabOptions;
	#seq = 0;
	/** Bumped whenever a name or address changes; see #sync(). */
	#hostsVersion = 1;

	constructor(opts: LabOptions) {
		this.#opts = opts;
		this.subnet = new Subnet(opts.cidr ?? "10.88.0.0/24");
		this.manifest = opts.manifest;
	}

	get defaultDistro(): string {
		return this.manifest.distros[0]?.name ?? "alpine";
	}

	/** The shared bytes of a mirrored image, fetched at most once. */
	image(name: string): Promise<ArrayBufferLike> {
		const d = this.manifest.distros.find((x) => x.name === name);
		if (!d) throw new Error(`no mirrored image for ${name}; run: node scripts/fetch-distros.ts ${name}`);
		return loadImage(`distros/${d.file}`, d.size);
	}

	hosts(): HostEntry[] {
		return this.machines.map((m) => ({ ip: m.ip, name: m.name }));
	}

	#freeHostNum(): number {
		const taken = new Set(this.machines.map((m) => Number(m.ip.split(".").pop())));
		let n = FIRST_HOST;
		while (taken.has(n)) n++;
		return n;
	}

	#freeName(base: string): string {
		if (!this.machines.some((m) => m.name === base)) return base;
		for (let i = 2; ; i++) {
			const candidate = `${base}${i}`;
			if (!this.machines.some((m) => m.name === candidate)) return candidate;
		}
	}

	add(opts: AddOptions = {}): Machine {
		const port = PORTS.find((p) => !this.machines.some((m) => m.port === p));
		if (port === undefined) throw new Error(`switch0 has no free port`);
		const hostNum = opts.hostNum ?? this.#freeHostNum();
		if (hostNum < 2 || hostNum > 254) throw new Error(`address ${hostNum} is outside ${this.subnet}`);
		const name = this.#freeName(opts.name?.trim() || `node${this.machines.length + 1}`);
		const distro = opts.distro ?? this.defaultDistro;

		const image = this.image(distro);
		const cfg: Omit<VmConfig, "image"> = {
			id: `vm${++this.#seq}`,
			name,
			ip: this.subnet.host(hostNum),
			prefixBits: this.subnet.bits,
			mac: labMac(hostNum),
			labCidr: this.subnet.toString(),
			distro,
			memoryMiB: opts.memoryMiB ?? 256,
			// Every machine already in the lab, plus this one.
			hosts: [...this.hosts(), { ip: this.subnet.host(hostNum), name }],
			internet: opts.internet ?? false,
			wispServers: this.#opts.wispServers,
			cols: 100,
			rows: 30,
		};

		const m: Machine = new Machine(cfg, image, this.sw, port, {
			onChange: () => {
				// A machine that has just finished booting may have missed host
				// table changes made while it was still coming up.
				this.#sync();
				this.#opts.onChange();
			},
		});
		// It boots with the host table as it stands, so it is already current.
		m.hostsVersion = ++this.#hostsVersion;
		this.machines.push(m);
		// The newcomer belongs in everyone else's /etc/hosts now.
		this.#sync();
		this.#opts.onChange();
		return m;
	}

	remove(id: string): void {
		const i = this.machines.findIndex((m) => m.id === id);
		if (i < 0) return;
		const [m] = this.machines.splice(i, 1);
		m.destroy();
		this.#hostsVersion++;
		this.#sync();
		this.#opts.onChange();
	}

	rename(id: string, name: string): void {
		const m = this.byId(id);
		if (!m) return;
		const trimmed = name.trim();
		if (!trimmed || trimmed === m.name) return;
		m.name = this.#freeName(trimmed);
		m.hostsVersion = 0;
		this.#hostsVersion++;
		this.#sync();
		this.#opts.onChange();
	}

	byId(id: string): Machine | undefined {
		return this.machines.find((m) => m.id === id);
	}

	/**
	 * Give every running machine the current host table. A machine added while
	 * another was still booting would otherwise never reach the one that was
	 * mid-boot, so this runs on every state change as well, and each guest
	 * remembers the version it was given.
	 */
	#sync(): void {
		const hosts = this.hosts();
		for (const m of this.machines) {
			if (m.state !== "ready" || m.hostsVersion >= this.#hostsVersion) continue;
			m.hostsVersion = this.#hostsVersion;
			m.reconfigure(hosts, this.subnet.bits);
		}
	}

	clear(): void {
		for (const m of this.machines.splice(0)) m.destroy();
		this.#opts.onChange();
	}
}
