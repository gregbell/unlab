import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "vitest";
import { parseSshPublicKey } from "./tailcat.ts";

function field(bytes: Uint8Array | string): Buffer {
	const value = typeof bytes === "string" ? Buffer.from(bytes) : bytes;
	const length = Buffer.alloc(4);
	length.writeUInt32BE(value.length);
	return Buffer.concat([length, value]);
}

const pair = generateKeyPairSync("ed25519");
const raw = pair.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
const ed25519 = Buffer.concat([field("ssh-ed25519"), field(raw)]).toString("base64");

describe("shared SSH authorization", () => {
	test("accepts an OpenSSH public key and preserves its comment", () => {
		expect(parseSshPublicKey(`  ssh-ed25519 ${ed25519} laptop  `)).toBe(`ssh-ed25519 ${ed25519} laptop`);
	});
	test.each([
		"",
		"-----BEGIN OPENSSH PRIVATE KEY-----",
		`ssh-rsa ${ed25519}`,
		`ssh-ed25519 ${ed25519}\nssh-ed25519 ${ed25519}`,
		`command="sh" ssh-ed25519 ${ed25519}`,
		"ssh-ed25519 AAAA",
		`ssh-ed25519 ${Buffer.concat([field("ssh-ed25519"), field(new Uint8Array(31))]).toString("base64")}`,
		`ssh-ed25519 ${Buffer.concat([field("ssh-ed25519"), field(raw), Buffer.from([0])]).toString("base64")}`,
	])("rejects malformed, mismatched, or multiple keys: %s", (key) => {
		expect(() => parseSshPublicKey(key)).toThrow("Paste one valid OpenSSH");
	});
});
