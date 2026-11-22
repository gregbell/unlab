// Running things inside a guest, and the setup each machine gets at boot.
//
// On the distro images vm.exec() runs as the unprivileged user `user`, who
// has passwordless sudo; the bare base shell (no distro) is already root and
// has no sudo at all. The SUDO_SH / execAsRoot pattern below handles both and
// is taken from unkernel's own web/src/sudo.ts (MIT, Pooya Parsa).

import type { ExecOptions, ExecResult, KernelHandle } from "unkernel";
import type { HostEntry } from "../model/index.ts";

export const SUDO_SH = `if [ "$(id -u)" != 0 ] && command -v sudo >/dev/null 2>&1; then SUDO=sudo; else SUDO=; fi`;

const AS_ROOT_SH = `${SUDO_SH}
s=$1
shift
exec \${SUDO:+$SUDO -n} /bin/sh -c "$s" sh "$@"`;

/** Run a shell script as root in the guest, with args as $1... */
export function execAsRoot(
	vm: KernelHandle,
	script: string,
	args: string[] = [],
	opts?: ExecOptions & { encoding?: "utf8" },
): Promise<ExecResult> {
	return vm.exec("/bin/sh", ["-c", AS_ROOT_SH, "sh", script, ...args], opts);
}

export interface SetupOptions {
	hostname: string;
	/** This machine's lab address and prefix length, e.g. 10.88.0.11 and 24. */
	ip: string;
	prefixBits: number;
	/** The other machines, written into /etc/hosts so names work with no DNS. */
	hosts: readonly HostEntry[];
	/** Ask udhcpc for the uplink address (10.0.2.15) so the internet works. */
	dhcp: boolean;
}

const PROMPT_FILE = "/etc/profile.d/kw-unlab.sh";

/**
 * The prompt every shell in the guest prints: the last command's exit status
 * (OSC 133 D), a prompt-start mark (A), the image's own prompt, then an
 * input-start mark (B). shell-tracker.ts reads these to learn exit codes and
 * whether a session is busy. busybox ash and bash both expand it.
 */
const PROMPT = String.raw`PS1='\[\033]133;D;$?\007\033]133;A\007\]'"$PS1"'\[\033]133;B\007\]'`;

/**
 * Login shells read the profile, and so does the image's ENV file, which
 * sources kw-*.sh. The console's login shell started before setup ran, so it
 * is hung up once: init respawns it, and the new shell prints a marked prompt
 * over the old line. Only a changed profile does that, so a second run leaves
 * the shell someone is using alone.
 */
const PROMPT_SH = [
	`want=${sh(PROMPT)}`,
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
 * Bring the machine onto the lab segment: its name, its lab address on eth0,
 * /etc/hosts for every machine in the lab, and the marked prompt. With an
 * uplink, udhcpc also claims 10.0.2.15 and installs the default route, which
 * is what carries `apk add` and anything else bound for the internet.
 *
 * Idempotent: a second run with the same options changes nothing, and a run
 * with a new host table changes only /etc/hosts.
 */
export function setupScript(o: SetupOptions): string {
	const hosts = [
		`127.0.0.1 localhost`,
		`${o.ip} ${o.hostname}`,
		...o.hosts.filter((h) => h.name !== o.hostname).map((h) => `${h.ip} ${h.name}`),
	];
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
		`ip addr replace ${o.ip}/${o.prefixBits} dev eth0`,
		// Last, so the first marked prompt appears on a machine that is already configured.
		PROMPT_SH,
	].join("\n");
}

/** Single-quote a string for POSIX sh. */
export function sh(s: string): string {
	return `'${s.replaceAll("'", `'\\''`)}'`;
}
