// Puts a file in a guest, over a session of its own that no terminal shows.
// The browser's worker and the Node tests share it.

import type { KernelHandle } from "unkernel";
import type { FileOutcome, GuestFile } from "../commands/index.ts";
import { execAsRoot } from "./guest.ts";

/** A guest that has not written a file by now is too busy, or hung. */
export const WRITE_MS = 60_000;

/**
 * The text is all there and on the disk under another name before it takes the
 * file's place, so a guest that goes down, a file system that is full and a
 * session that ends leave the old file. A file that nothing can take the place
 * of, a mount point or one of /proc, is written over, and put back if that fails.
 *
 * The text comes on stdin, because a session's arguments hold 64 KiB. Prints
 * what it did: a word, then a line for each thing the word is about.
 */
const SCRIPT = `
export LC_ALL=C
umask 022
path=$1 owner=$2 mode=$3 size=$4
user=\${owner%%:*}
dir=$(dirname "$path")
new= old= made=0 over= had= had_mode=

undo() {
  [ -z "$new" ] || rm -f "$new"
  [ -z "$old" ] || rm -f "$old"
  d=$dir
  while [ "$made" -gt 0 ]; do
    rmdir "$d" 2>/dev/null
    d=$(dirname "$d")
    made=$((made - 1))
  done
}
trap undo EXIT
trap 'exit 1' HUP INT TERM

say() { printf '%s\\n' "$@"; }
refuse() { say "$@"; exit 0; }
broke() { refuse broke "$(df -P "$there" 2>/dev/null | sed -n '2s/.*% //p')" "$1"; }
own() {
  said=$(chown "$1" "$2" 2>&1) && return
  case $user in *[!0-9]*) id -u "$user" >/dev/null 2>&1 || refuse user "$user" ;; esac
  group=\${owner#"$user"}
  group=\${group#:}
  case $group in *[!0-9]*) grep -q "^$group:" /etc/group || refuse group "$group" ;; esac
  broke "$said"
}

there=$dir missing=0
while [ ! -e "$there" ] && [ ! -L "$there" ]; do
  missing=$((missing + 1))
  there=$(dirname "$there")
done
[ -d "$there" ] || refuse not-directory "$there"

file=$path
if [ -L "$path" ]; then
  file=$(readlink -f "$path")
  [ -n "$file" ] && [ -d "$(dirname "$file")" ] || refuse dangling "$(readlink "$path")"
  there=$(dirname "$file")
fi
[ ! -d "$file" ] || refuse directory "$file"
if [ -e "$file" ]; then
  [ -f "$file" ] || refuse special "$file"
  had=$(stat -c %u:%g "$file") had_mode=$(stat -c %a "$file")
fi
case $owner in
  "" | *:*) group= ;;
  *[!0-9]*) group=$(id -g "$owner" 2>/dev/null) ;;
  # busybox's id takes no number.
  *) group=$(sed -n "s/^[^:]*:[^:]*:$owner:\\([0-9]*\\):.*/\\1/p" /etc/passwd | head -n 1) ;;
esac
owner=$owner\${group:+:$group}

made=$missing
said=$(mkdir -p "$dir" 2>&1) || broke "$said"
if said=$(mktemp "$(dirname "$file")/.unlab.XXXXXX" 2>&1); then
  new=$said
else
  case $said in *"No space left"*) broke "$said" ;; esac
  [ -n "$had" ] || broke "$said"
  over=yes
  new=$(mktemp /run/unlab.XXXXXX)
fi
said=$( { cat > "$new"; } 2>&1) || broke "$said"
[ "$(wc -c < "$new")" -eq "$size" ] || refuse short

if [ -z "$over" ]; then
  [ -z "$owner$had" ] || own "\${owner:-$had}" "$new"
  said=$(chmod "\${mode:-\${had_mode:-644}}" "$new" 2>&1) || broke "$said"
  said=$(sync "$new" 2>&1) || broke "$said"
  if said=$(mv -fT "$new" "$file" 2>&1); then
    new=
  else
    [ -n "$had" ] || broke "$said"
    over=yes
  fi
fi

if [ -n "$over" ]; then
  # An owner nobody knows is refused before anything is changed.
  [ -z "$owner" ] || own "$owner" "$new"
  old=$(mktemp /run/unlab.XXXXXX)
  said=$( { cat "$file" > "$old"; } 2>&1) || broke "$said"
  if ! said=$( { cat "$new" > "$file" && { [ -z "$owner" ] || chown "$owner" "$file"; } &&
    { [ -z "$owner$mode" ] || chmod "\${mode:-$had_mode}" "$file"; } } 2>&1); then
    cat "$old" > "$file"
    [ -z "$owner" ] || chown "$had" "$file"
    [ -z "$owner$mode" ] || chmod "$had_mode" "$file"
    broke "$said"
  fi
fi

d=$dir
while [ -n "$owner" ] && [ "$missing" -gt 0 ]; do
  chown "$owner" "$d"
  d=$(dirname "$d")
  missing=$((missing - 1))
done
made=0
sync "$file" "$(dirname "$file")" || sync
say wrote "$file" "$(stat -c '%U:%u %G:%g' "$file")" "$(stat -c %a "$file")"
`;

/** The last of what a program said went wrong: `mv: can't rename 'a': Not permitted` is `Not permitted`. */
const problem = (said: string): string => said.trim().split("\n").at(-1)?.split(": ").at(-1) ?? "";

/** `bob:1000` is bob, and `UNKNOWN:1234` is 1234. */
function account(named: string): string {
	const [name, id] = named.split(":");
	return name === "UNKNOWN" ? id : name;
}

function read(machine: string, path: string, [word, ...about]: readonly string[]): FileOutcome | null {
	const refused = (reason: string): FileOutcome => ({ kind: "refused", reason });
	switch (word) {
		case "wrote": {
			const [file, owner, mode] = about;
			return { kind: "written", path: file, owner: owner.split(" ").map(account).join(":"), mode };
		}
		case "not-directory":
			return refused(`${about[0]} on ${machine} is not a directory, so ${path} cannot be in it.`);
		case "directory":
			return refused(`${about[0]} on ${machine} is a directory, so give the path of a file in it.`);
		case "special":
			return refused(`${about[0]} on ${machine} is not a regular file, so write cannot replace it.`);
		case "dangling":
			return refused(`${path} on ${machine} is a link to ${about[0]}, and the directory that is in does not exist.`);
		case "user":
			return refused(`${machine} has no user called ${about[0]}, so --owner cannot name it.`);
		case "group":
			return refused(`${machine} has no group called ${about[0]}, so --owner cannot name it.`);
		case "short":
			return refused(`The text did not all reach ${machine}, so ${path} was not written.`);
		case "broke": {
			const [mount, ...said] = about;
			const why = problem(said.join("\n"));
			const fileSystem = `The file system${mount === "" ? "" : ` on ${mount}`} of ${machine}`;
			if (why === "Read-only file system") return refused(`${fileSystem} is read-only, so ${path} cannot be written.`);
			if (why === "No space left on device") return refused(`${fileSystem} is full, so ${path} was not written.`);
			return refused(`${machine} could not write ${path}: ${why}.`);
		}
		default:
			return null;
	}
}

/** Never rejects. */
export async function writeFile(
	vm: Pick<KernelHandle, "exec">,
	machine: string,
	{ path, text, owner, mode }: GuestFile,
	ms = WRITE_MS,
): Promise<FileOutcome> {
	const unsure = (what: string): FileOutcome => ({
		kind: "unsure",
		reason: `${machine} ${what}, so check whether ${path} was written.`,
	});
	const input = new TextEncoder().encode(text);
	const late = AbortSignal.timeout(ms);
	try {
		const args = [path, owner ?? "", mode ?? "", String(input.length)];
		const { stdout, stderr } = await execAsRoot(vm, SCRIPT, args, { input, signal: late });
		return read(machine, path, stdout.trimEnd().split("\n")) ?? unsure(`ended with ${problem(stderr) || "no answer"}`);
	} catch (error) {
		if (late.aborted) return unsure(`did not answer in ${ms / 1000} s`);
		return unsure(`stopped answering (${error instanceof Error ? error.message : String(error)})`);
	}
}
