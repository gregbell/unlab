import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { expect, test } from "vitest";

const SSH = new URL("../public/ssh/", import.meta.url);
const read = (file: string) => readFileSync(new URL(file, SSH));
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const INTERPRETER = 3;

/** The types of an ELF file's program headers. */
function segments(elf: Buffer): number[] {
	const at = Number(elf.readBigUInt64LE(32));
	const size = elf.readUInt16LE(54);
	return Array.from({ length: elf.readUInt16LE(56) }, (_, i) => elf.readUInt32LE(at + i * size));
}

interface Program {
	readonly name: string;
	readonly file: string;
	readonly size: number;
	readonly sha256: string;
	readonly source: string;
	readonly sourceSha256: string;
}

const { programs } = JSON.parse(read("manifest.json").toString()) as { programs: Program[] };
const script = readFileSync(new URL("./build-ssh-server.ts", import.meta.url), "utf8");

test.each(programs)("$name is the program its manifest says, built from the release the script pins", (program) => {
	const bytes = read(program.file);
	expect(bytes.length).toBe(program.size);
	expect(sha256(bytes)).toBe(program.sha256);
	// An aarch64 executable that needs no interpreter, and so no library of the image's.
	expect(bytes.subarray(0, 4).toString("latin1")).toBe("\x7fELF");
	expect(bytes.readUInt16LE(18)).toBe(183);
	expect(segments(bytes)).not.toContain(INTERPRETER);
	expect(script).toContain(program.source);
	expect(script).toContain(program.sourceSha256);
});

test("each program's licence is published beside it, and nothing else is", () => {
	const expected = programs.flatMap(({ file }) => [file, `${file}.licence.txt`]);
	expect(readdirSync(SSH).sort()).toEqual([...expected, "manifest.json"].sort());
	for (const { file } of programs) expect(read(`${file}.licence.txt`).length).toBeGreaterThan(1000);
});
