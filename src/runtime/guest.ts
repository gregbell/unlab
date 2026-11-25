// Running things inside a guest, and the setup each machine gets at boot.
//
// On the distro images vm.exec() runs as the unprivileged user `user`, who
// has passwordless sudo; the bare base shell (no distro) is already root and
// has no sudo at all. The SUDO_SH / execAsRoot pattern below handles both and
// is taken from unkernel's own web/src/sudo.ts (MIT, Pooya Parsa).

import type { ExecOptions, ExecResult, KernelHandle } from "unkernel";
import type { Address, HostEntry } from "../model/index.ts";
import { addressStr } from "../net/index.ts";
import { BOOT_LEASE } from "./boot-lease.ts";

export const SUDO_SH = `if [ "$(id -u)" != 0 ] && command -v sudo >/dev/null 2>&1; then SUDO=sudo; else SUDO=; fi`;

const AS_ROOT_SH = `${SUDO_SH}
s=$1
shift
exec \${SUDO:+$SUDO -n} /bin/sh -c "$s" sh "$@"`;

/** Run a shell script as root in the guest, with args as $1... */
export function execAsRoot(
	vm: Pick<KernelHandle, "exec">,
	script: string,
	args: string[] = [],
	opts?: ExecOptions & { encoding?: "utf8" },
): Promise<ExecResult> {
	return vm.exec("/bin/sh", ["-c", AS_ROOT_SH, "sh", script, ...args], opts);
}

export interface SetupOptions {
	hostname: string;
	/** Show the hostname in the prompt, as a name someone chose is. */
	namedPrompt: boolean;
	/** The address the lab set on each NIC, eth0 first, or null for one that comes up with none. */
	addresses: readonly (Address | null)[];
	/** The machines that have an address, written into /etc/hosts so names work with no DNS. */
	hosts: readonly HostEntry[];
	/** The package gateway leases eth0 an address of its own, beside the lab's. */
	gateway: boolean;
	/** Carried in every prompt mark, so marks printed by programs are not believed. Hex only. */
	promptToken: string;
}

export interface HostsOptions {
	hostname: string;
	hosts: readonly HostEntry[];
}

const PROMPT_FILE = "/etc/profile.d/kw-unlab.sh";

/**
 * The prompt every shell in the guest prints: the last command's exit status
 * (OSC 133 D), a prompt-start mark (A), the image's own prompt after the name
 * someone gave the machine, then an input-start mark (B), each carrying this
 * boot's token. shell-tracker.ts reads these to learn exit codes and whether a
 * session is busy, and ignores marks without the token. busybox ash and bash both expand it.
 *
 * `redraw=0` keeps the terminal from erasing the prompt on a resize for the
 * shell to print again. It takes everything since the prompt for the prompt,
 * so it would erase a running command and its output too.
 */
function promptLine(token: string, named: boolean): string {
	if (!/^[0-9a-f]+$/.test(token)) throw new Error("the prompt token must be hex");
	const tag = `;unlab=${token}`;
	const name = named ? String.raw`\h ` : "";
	return String.raw`PS1='\[\033]133;D;$?$(sync)${tag}\007\033]133;A;redraw=0${tag}\007\]${name}'"$PS1"'\[\033]133;B${tag}\007\]'`;
}

/**
 * Login shells read the profile, and so does the image's ENV file, which
 * sources kw-*.sh. The console's login shell started before setup ran, so it
 * is hung up once: init respawns it, and the new shell prints a marked prompt
 * over the old line. Only a changed profile does that, so a second run leaves
 * the shell someone is using alone.
 */
const promptScript = (token: string, named: boolean) =>
	[
		`want=${sh(promptLine(token, named))}`,
		`if [ "$(cat ${PROMPT_FILE} 2>/dev/null)" != "$want" ]; then`,
		`  mkdir -p /etc/profile.d`,
		`  printf '%s\\n' "$want" > ${PROMPT_FILE}`,
		`  printf '\\r\\033[K' > /dev/hvc0 || true`,
		`  for p in /proc/[0-9]*; do`,
		`    case "$(head -c1 "$p/cmdline" 2>/dev/null)" in -) ;; *) continue ;; esac`,
		`    if [ "$(readlink "$p/fd/0" 2>/dev/null)" = /dev/hvc0 ]; then kill -HUP "\${p#/proc/}" 2>/dev/null || true; fi`,
		`  done`,
		`fi`,
	].join("\n");

/**
 * Bring the machine onto the lab: its name, the address the lab set on each
 * NIC, /etc/hosts for every machine that has one, and the marked prompt. With
 * the gateway, the image's udhcpc also claims 10.0.2.15 and installs the
 * default route, which carries package repository traffic.
 *
 * Idempotent: a second run with the same options changes nothing, and a run
 * with a new host table changes only /etc/hosts.
 */
export function setupScript(o: SetupOptions): string {
	return [
		`set -e`,
		`hostname ${sh(o.hostname)}`,
		hostsScript(o),
		// Debian ships ping in the kernel's base filesystem. Make it available to ordinary shell commands.
		`if ! command -v ping >/dev/null && [ -x /run/kw-lower/bin/ping ] && [ ! -e /usr/bin/ping ] && [ ! -L /usr/bin/ping ]; then ln -s /run/kw-lower/bin/ping /usr/bin/ping; fi`,
		// Let the unprivileged console shell use ICMP sockets, so `ping node2`
		// works without sudo. Harmless: it only widens who may send echoes.
		`sysctl -w net.ipv4.ping_group_range='0 2147483647' >/dev/null 2>&1 || true`,
		// Every NIC is on the one switch, and Linux would answer on all of them for an address that only one has.
		...(o.addresses.length > 1
			? [`sysctl -w net.ipv4.conf.all.arp_ignore=1 net.ipv4.conf.all.arp_announce=2 >/dev/null`]
			: []),
		...o.addresses.map((_, nic) => `ip link set eth${nic} up`),
		// The image's DHCP script flushes eth0 before installing its lease.
		// Wait for it before adding the lab's address (Debian runs DHCP in the background).
		...(o.gateway
			? [`/usr/lib/kw/net wait`]
			: [
					`/usr/lib/kw/net wait || true`,
					`ip addr del ${BOOT_LEASE.address}/${BOOT_LEASE.prefix} dev eth0 2>/dev/null || true`,
				]),
		...o.addresses.flatMap((address, nic) => (address ? [`ip addr replace ${addressStr(address)} dev eth${nic}`] : [])),
		// Last, so the first marked prompt appears on a machine that is already configured.
		promptScript(o.promptToken, o.namedPrompt),
	].join("\n");
}

const BEGIN = "# unlab: begin";
const END = "# unlab: end";

/**
 * The lab's machines in /etc/hosts, between marker lines, so names work with
 * no DNS. Only that block is ever rewritten: lines someone added by hand stay.
 * This is all a new host table changes in a running guest, so it never undoes
 * a link, an address or a hostname someone set on purpose.
 */
export function hostsScript(o: HostsOptions): string {
	// sudo looks its own machine's name up, and one with no address is nowhere else to be found.
	const own = o.hosts.find((h) => h.name === o.hostname) ?? { ip: "127.0.1.1", name: o.hostname };
	const entries = [own, ...o.hosts.filter((h) => h.name !== o.hostname)].map((h) => `${h.ip} ${h.name}`);
	const block = [BEGIN, ...entries, END].map((line) => sh(line)).join(" ");
	return [
		`{ sed ${sh(`/^${BEGIN}$/,/^${END}$/d`)} /etc/hosts 2>/dev/null || true; printf '%s\\n' ${block}; } > /etc/hosts.unlab`,
		// cat, not mv: some images bind-mount /etc/hosts, and a rename would not reach it.
		`cat /etc/hosts.unlab > /etc/hosts && rm -f /etc/hosts.unlab`,
	].join("\n");
}

/** Single-quote a string for POSIX sh. */
export function sh(s: string): string {
	return `'${s.replaceAll("'", `'\\''`)}'`;
}
