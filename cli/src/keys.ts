// The CLI's own SSH keys and configuration, in its own directory. None of the
// person's are read or written.
//
// One host key serves every machine: each is given it when its server starts,
// and the link is what says which machine a connection reaches. So a machine
// that rebooted, or took a removed one's name, is known without a question.

import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SshKeys } from "../../src/streams/index.ts";

export function configDir(): string {
	return process.env.UNLAB_CONFIG ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "unlab");
}

const string = (bytes: Uint8Array | string) => {
	const body = Buffer.from(bytes);
	const length = Buffer.alloc(4);
	length.writeUInt32BE(body.length);
	return Buffer.concat([length, body]);
};

interface Raw {
	readonly seed: Buffer;
	readonly point: Buffer;
}

function raw(key: KeyObject): Raw {
	const { d, x } = key.export({ format: "jwk" }) as { d: string; x: string };
	return { seed: Buffer.from(d, "base64url"), point: Buffer.from(x, "base64url") };
}

const publicBlob = ({ point }: Raw) => Buffer.concat([string("ssh-ed25519"), string(point)]);

export const publicLine = (key: Raw) => `ssh-ed25519 ${publicBlob(key).toString("base64")}`;

/** As dropbear keeps it. */
const dropbearKey = ({ seed, point }: Raw) =>
	Buffer.concat([string("ssh-ed25519"), string(Buffer.concat([seed, point]))]);

/** As OpenSSH keeps it, with no passphrase. */
function opensshKey(key: Raw): string {
	const check = Buffer.alloc(4, 0x5a);
	let secret = Buffer.concat([
		check,
		check,
		publicBlob(key),
		string(Buffer.concat([key.seed, key.point])),
		string("unlab"),
	]);
	for (let i = 1; secret.length % 8 !== 0; i++) secret = Buffer.concat([secret, Buffer.of(i)]);
	const one = Buffer.alloc(4);
	one.writeUInt32BE(1);
	const body = Buffer.concat([
		Buffer.from("openssh-key-v1\0"),
		string("none"),
		string("none"),
		string(""),
		one,
		string(publicBlob(key)),
		string(secret),
	]);
	const lines = body.toString("base64").match(/.{1,70}/g) ?? [];
	return ["-----BEGIN OPENSSH PRIVATE KEY-----", ...lines, "-----END OPENSSH PRIVATE KEY-----", ""].join("\n");
}

function keep(path: string, text: string, mode: number): void {
	const part = `${path}.part`;
	writeFileSync(part, text, { mode });
	chmodSync(part, mode);
	renameSync(part, path);
}

/** A key of the CLI's own, made the first time. */
function keyAt(path: string): Raw {
	if (!existsSync(path)) {
		const { privateKey } = generateKeyPairSync("ed25519");
		keep(path, privateKey.export({ format: "pem", type: "pkcs8" }) as string, 0o600);
	}
	const key = createPrivateKey(readFileSync(path));
	if (createPublicKey(key).asymmetricKeyType !== "ed25519") throw new Error(`${path} is not a key of the CLI's.`);
	return raw(key);
}

export interface SshFiles {
	readonly dir: string;
	readonly config: string;
	readonly keys: SshKeys;
}

const quoted = (path: string) => `"${path}"`;

/** Where a running CLI is asked. `ssh` is told, as a terminal's environment may say otherwise. */
export const socketPath = () => join(configDir(), "cli.sock");

/** `proxy` is the command that carries a connection: it is given the machine's name. */
export function sshFiles(proxy: readonly string[]): SshFiles {
	const dir = configDir();
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
	const client = keyAt(join(dir, "client.pem"));
	const host = keyAt(join(dir, "host.pem"));
	const identity = join(dir, "id_ed25519");
	const knownHosts = join(dir, "known_hosts");
	const config = join(dir, "ssh_config");
	keep(identity, opensshKey(client), 0o600);
	keep(knownHosts, `unlab ${publicLine(host)}\n`, 0o600);
	const lines = [
		"# Written by the unlab CLI each time it starts.",
		"Host *.unlab",
		"	User user",
		`	ProxyCommand ${proxy.map(quoted).join(" ")} proxy %h ${quoted(socketPath())}`,
		`	IdentityFile ${quoted(identity)}`,
		"	IdentitiesOnly yes",
		"	IdentityAgent none",
		`	UserKnownHostsFile ${quoted(knownHosts)}`,
		"	GlobalKnownHostsFile none",
		"	HostKeyAlias unlab",
		"	CheckHostIP no",
		"	StrictHostKeyChecking yes",
		"	UpdateHostKeys no",
		"	ControlPath none",
		"	LogLevel ERROR",
		"",
	];
	keep(config, lines.join("\n"), 0o600);
	return {
		dir,
		config,
		keys: { hostKey: dropbearKey(host).toString("base64"), authorizedKey: `${publicLine(client)} unlab-cli` },
	};
}
