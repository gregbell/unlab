// Builds what the lab puts in a machine for SSH, from pinned releases, as static
// aarch64 programs: dropbear, the sftp-server that scp uses, and rsync for an
// image without one. Writes them to public/ssh/ with a manifest of their checksums.
// Needs zig on the PATH, for its cross compiler, and make, perl and tar:
//   npm run ssh-server
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = fileURLToPath(new URL("../public/ssh/", import.meta.url));
const TARGET = "aarch64-linux-musl";

interface Source {
	readonly name: string;
	readonly version: string;
	readonly url: string;
	readonly sha256: string;
	/** The licence, in the source tree. */
	readonly licence: string;
	/** The program that is built, in the source tree. */
	readonly program: string;
	build(dir: string, run: Run): void;
}

type Run = (command: string, args: readonly string[]) => void;

/** Where the lab puts the programs. dropbear is built to look for the others there. */
const GUEST_DIR = "/run/unlab-ssh";

const SOURCES: readonly Source[] = [
	{
		name: "dropbear",
		version: "2026.91",
		url: "https://matt.ucc.asn.au/dropbear/releases/dropbear-2026.91.tar.bz2",
		sha256: "defa924475abf6bc1e74abc00173e46bfdc804bd47caafa14f5a4ef0cc76da34",
		licence: "LICENSE",
		program: "dropbear",
		build(dir, run) {
			// As a login has on every image: sudo finds apk by the PATH it is run with.
			const path = `"/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${GUEST_DIR}"`;
			const options = [
				`#define SFTPSERVER_PATH "${GUEST_DIR}/sftp-server"`,
				`#define DEFAULT_PATH ${path}`,
				`#define DEFAULT_ROOT_PATH ${path}`,
				"#define DROPBEAR_SVR_PASSWORD_AUTH 0",
				"#define DO_MOTD 0",
			];
			writeFileSync(join(dir, "localoptions.h"), `${options.join("\n")}\n`);
			run("./configure", [
				`--host=${TARGET}`,
				"--enable-static",
				"--enable-bundled-libtom",
				"--disable-zlib",
				"--disable-lastlog",
				"--disable-utmp",
				"--disable-utmpx",
				"--disable-wtmp",
				"--disable-wtmpx",
				"--disable-loginfunc",
			]);
			run("make", ["-j8", "PROGRAMS=dropbear"]);
		},
	},
	{
		name: "sftp-server",
		version: "10.6p2",
		url: "https://cdn.openbsd.org/pub/OpenBSD/OpenSSH/portable/openssh-10.6p2.tar.gz",
		sha256: "9ae44872090cf2f06b3cf9ff147e7f16f309671340763ed2f99248398ae29d5b",
		licence: "LICENCE",
		program: "sftp-server",
		build(_dir, run) {
			run("./configure", [
				`--host=${TARGET}`,
				"--without-openssl",
				"--without-zlib",
				"--without-pam",
				"--without-shadow",
				"--disable-security-key",
				"--with-ldflags=-static",
				"--with-sandbox=no",
			]);
			run("make", ["-j8", "sftp-server"]);
		},
	},
	{
		name: "rsync",
		version: "3.5.2",
		url: "https://download.samba.org/pub/rsync/src/rsync-3.5.2.tar.gz",
		sha256: "a10d591825251e070f74c98df3daad195def4ed81b4a2de16169026aea33f6c8",
		licence: "COPYING",
		program: "rsync",
		build(_dir, run) {
			run("./configure", [
				`--host=${TARGET}`,
				"--disable-openssl",
				"--disable-xxhash",
				"--disable-zstd",
				"--disable-lz4",
				"--disable-idn",
				"--disable-iconv",
				"--disable-iconv-open",
				"--disable-acl-support",
				"--disable-xattr-support",
				"--disable-md2man",
				"--disable-roll-simd",
				"--disable-debug",
				"--with-included-popt",
				"--with-included-zlib",
			]);
			run("make", ["-j8", "rsync"]);
		},
	},
];

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function build(source: Source, root: string): Promise<{ file: string; size: number; sha256: string }> {
	const response = await fetch(source.url);
	if (!response.ok) throw new Error(`${source.url}: HTTP ${response.status}`);
	const archive = new Uint8Array(await response.arrayBuffer());
	if (sha256(archive) !== source.sha256) throw new Error(`${source.url} is ${sha256(archive)}, not the pinned release`);
	const dir = join(root, source.name);
	mkdirSync(dir);
	const path = join(root, `${source.name}.tar`);
	writeFileSync(path, archive);
	execFileSync("tar", ["xf", path, "-C", dir, "--strip-components=1"]);
	const wrap = (tool: string) => {
		const script = join(root, `zig-${tool}`);
		const target = tool === "cc" ? ` -target ${TARGET}` : "";
		writeFileSync(script, `#!/bin/sh\nexec zig ${tool}${target} "$@"\n`, { mode: 0o755 });
		return script;
	};
	const env = {
		...process.env,
		CC: wrap("cc"),
		AR: wrap("ar"),
		RANLIB: wrap("ranlib"),
		STRIP: ":",
		// zig's undefined behaviour traps would end these programs for what their authors run without.
		CFLAGS: `-Os -fno-sanitize=undefined -ffile-prefix-map=${dir}=.`,
		LDFLAGS: "-static -s",
		SOURCE_DATE_EPOCH: "0",
	};
	source.build(dir, (command, args) => {
		execFileSync(command, args, { cwd: dir, env, stdio: ["ignore", "ignore", "inherit"] });
	});
	const binary = readFileSync(join(dir, source.program));
	const file = source.name;
	writeFileSync(join(OUT, file), binary);
	copyFileSync(join(dir, source.licence), join(OUT, `${source.name}.licence.txt`));
	console.log(`${source.name} ${source.version} is ${binary.length} bytes`);
	return { file, size: binary.length, sha256: sha256(binary) };
}

const root = mkdtempSync(join(tmpdir(), "unlab-ssh-"));
try {
	mkdirSync(OUT, { recursive: true });
	const programs = [];
	for (const source of SOURCES) {
		const { name, version, url, sha256: sourceSha256 } = source;
		programs.push({ name, ...(await build(source, root)), version, source: url, sourceSha256 });
	}
	const manifest = { guestDir: GUEST_DIR, programs };
	writeFileSync(join(OUT, "manifest.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
} finally {
	rmSync(root, { recursive: true });
}
