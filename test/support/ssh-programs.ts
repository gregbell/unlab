import { readFileSync } from "node:fs";
import type { SshPrograms } from "../../src/runtime/ssh-server.ts";

const at = (file: string) => readFileSync(new URL(`../../public/ssh/${file}`, import.meta.url));

/** The programs as the lab serves them. */
export function sshPrograms(): SshPrograms {
	const manifest = JSON.parse(at("manifest.json").toString()) as {
		guestDir: string;
		programs: { name: string; file: string }[];
	};
	return { dir: manifest.guestDir, programs: manifest.programs.map(({ name, file }) => ({ name, bytes: at(file) })) };
}
