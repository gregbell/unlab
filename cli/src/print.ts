// What the terminal shows, as text. Nothing here prints.

import type { Asking, LinkedMachine, RemoteResult } from "../../src/streams/index.ts";
import type { Status } from "./core.ts";

export function machinesLine(machines: readonly LinkedMachine[]): string {
	if (machines.length === 0) return "Linked to the lab, which has no machines yet. Try: spawn 2 alpine";
	const named = machines.map(
		({ name, image, state }) => `${name} (${state === "ready" ? image : `${image}, ${state}`})`,
	);
	return `Linked to the lab: ${named.join(", ")}`;
}

const columns = (rows: readonly (readonly string[])[]): string[] => {
	const width = Math.max(0, ...rows.map(([first]) => first.length));
	return rows.map(([first, ...rest]) =>
		[first.padEnd(width), ...rest]
			.filter((cell) => cell !== "")
			.join("  ")
			.trimEnd(),
	);
};

/** A result as the command bar shows it, with what machines printed above the summary. */
export function resultText(result: RemoteResult): string {
	if (!result.ok) return result.fix === null ? result.message : `${result.message}\nDid you mean: ${result.fix}`;
	const several = result.blocks.length > 1;
	const printed = result.blocks.flatMap(({ machine, output }) => {
		if (output === null || output === "") return [];
		return several ? [`== ${machine} ==`, output.replace(/\n$/, "")] : [output.replace(/\n$/, "")];
	});
	const ran = result.blocks.some(({ output }) => output !== null);
	const blocks = columns(
		result.blocks
			.filter(({ exitCode, output }) => !ran || several || output === null || exitCode !== 0)
			.map(({ machine, status, lastLine, output }) => [machine, status, output === null ? lastLine : ""]),
	);
	const rows = columns(result.rows.map(({ term, text }) => [term, text]));
	return [...printed, ...(ran && !several ? [] : [result.text]), ...blocks, ...rows].join("\n");
}

/** What a shell should see: the machine's own exit status when the command ran in one. */
export function exitCode(result: RemoteResult): number {
	if (!result.ok) return 1;
	const failed = result.blocks.find(({ exitCode }) => exitCode !== null && exitCode !== 0);
	if (failed) return failed.exitCode ?? 1;
	const ran = result.blocks.filter(({ output }) => output !== null);
	// It was to run in machines, and one skipped it or did not say how it went.
	const skipped = ran.some((block) => block.exitCode === null) || (ran.length > 0 && ran.length < result.blocks.length);
	return skipped ? 1 : 0;
}

export function askingText({ question, detail }: Asking): string {
	return `${question}\n${detail}`;
}

function bytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KiB`;
	return `${(n / 1024 ** 2).toFixed(1)} MiB`;
}

export function statusText({ linked, lan, machines, connections, forwards }: Status): string {
	const lines = [linked ? machinesLine(machines) : "The lab is not linked."];
	if (lan) lines.push("Machines may reach this computer and its local network (--lan).");
	for (const { machine, local, remote } of forwards) lines.push(`localhost:${local} leads to ${machine}:${remote}`);
	if (linked && connections.length === 0) lines.push("No connection to the internet is open.");
	for (const { machine, host, port, sent, received } of connections) {
		lines.push(`${machine} → ${host}:${port}  ${bytes(sent)} out, ${bytes(received)} in`);
	}
	return lines.join("\n");
}
