// Running things inside a guest, and the setup each machine gets at boot.
//
// On the distro images vm.exec() runs as the unprivileged user `user`, who
// has passwordless sudo; the bare base shell (no distro) is already root and
// has no sudo at all. The SUDO_SH / execAsRoot pattern below handles both and
// is taken from unkernel's own web/src/sudo.ts (MIT, Pooya Parsa).

import type { ExecOptions, ExecResult, KernelHandle } from "unkernel";

export const SUDO_SH = `if [ "$(id -u)" != 0 ] && command -v sudo >/dev/null 2>&1; then SUDO=sudo; else SUDO=; fi`;

const AS_ROOT_SH = `${SUDO_SH}
s=$1
shift
exec \${SUDO:+$SUDO -n} /bin/sh -c "$s" sh "$@"`;

/** Run a shell script as root in the guest, with args as $1... */
export function execAsRoot(vm: KernelHandle, script: string, args: string[] = [], opts?: ExecOptions & { encoding?: "utf8" }): Promise<ExecResult> {
	return vm.exec("/bin/sh", ["-c", AS_ROOT_SH, "sh", script, ...args], opts);
}

export interface HostEntry {
	ip: string;
	name: string;
}

export interface SetupOptions {
	hostname: string;
	/** This machine's lab address and prefix length, e.g. 10.88.0.11 and 24. */
	ip: string;
	prefixBits: number;
	/** The other machines, written into /etc/hosts so names work with no DNS. */
	hosts: HostEntry[];
	/** Ask udhcpc for the uplink address (10.0.2.15) so the internet works. */
	dhcp: boolean;
}

/**
 * Bring the machine onto the lab segment: its name, its lab address on eth0,
 * and /etc/hosts for every machine in the lab. With an uplink, udhcpc also
 * claims 10.0.2.15 and installs the default route, which is what carries
 * `apk add` and anything else bound for the internet.
 */
export function setupScript(o: SetupOptions): string {
	const hosts = [`127.0.0.1 localhost`, `${o.ip} ${o.hostname}`, ...o.hosts.filter((h) => h.name !== o.hostname).map((h) => `${h.ip} ${h.name}`)];
	return [
		`set -e`,
		`hostname ${sh(o.hostname)}`,
		// A matching /etc/hosts entry keeps sudo from stalling on a name lookup.
		`printf '%s\\n' ${hosts.map((l) => sh(l)).join(" ")} > /etc/hosts`,
		// Let the unprivileged console shell use ICMP sockets, so `ping node2`
		// works without sudo. Harmless: it only widens who may send echoes.
		`sysctl -w net.ipv4.ping_group_range='0 2147483647' >/dev/null 2>&1 || true`,
		`ip link set eth0 up`,
		// Before the lab address, never after: udhcpc's script flushes eth0 when
		// it installs the lease, which would take the lab address with it.
		o.dhcp ? `udhcpc -i eth0 -n -q -t 4 -T 1 >/dev/null 2>&1 || true` : `:`,
		// Idempotent: re-running setup after a rename must not fail here.
		`ip addr replace ${o.ip}/${o.prefixBits} dev eth0`,
	].join("\n");
}

/** Single-quote a string for POSIX sh. */
export function sh(s: string): string {
	return `'${s.replaceAll("'", `'\\''`)}'`;
}
