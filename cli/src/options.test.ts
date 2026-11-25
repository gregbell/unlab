import { expect, test } from "vitest";
import { lineOf, portPair, readOptions, shellWord, UsageError } from "./options.ts";

test("options come before the command, and what follows it is the command's own", () => {
	expect(readOptions([])).toMatchObject({
		port: 47122,
		origin: "https://unlab.run",
		words: [],
		lan: false,
		open: true,
	});
	expect(
		readOptions(["--json", "--port=5000", "--origin", "http://localhost:5173/x", "rm", "--yes", "node1"]),
	).toMatchObject({
		json: true,
		yes: false,
		port: 5000,
		origin: "http://localhost:5173",
		words: ["rm", "--yes", "node1"],
	});
});

test.each([
	[["--prot", "1"]],
	[["--port"]],
	[["--port", "0"]],
	[["--port", "x"]],
	[["--origin", "nowhere"]],
	[["--wait", "x"]],
])("%j is refused in a sentence", (args) => {
	expect(() => readOptions(args)).toThrow(UsageError);
});

test.each([
	[["ls"], "ls"],
	[["write", "node1", "/tmp/a b", "--", "x y"], "write node1 /tmp/a\\ b -- x y"],
	[["exec", "node1", "--", "uname", "-a"], "exec node1 -- uname -a"],
	[["exec", "node1", "--", "echo", "a b", "it's"], "exec node1 -- echo 'a b' 'it'\\''s'"],
	[["exec", "node1", "--", "echo $HOME | cat"], "exec node1 -- echo $HOME | cat"],
])("%j is the line %s", (words, line) => {
	expect(lineOf(words)).toBe(line);
});

test("a word the shell would change is quoted", () => {
	expect(shellWord("--flag=a/b")).toBe("--flag=a/b");
	expect(shellWord("$HOME")).toBe("'$HOME'");
	expect(shellWord("")).toBe("''");
});

test("a port is one number for both ends, or two", () => {
	expect(portPair("80")).toEqual({ local: 80, remote: 80 });
	expect(portPair("8080:80")).toEqual({ local: 8080, remote: 80 });
	for (const bad of ["", "x", "0", "70000", "1:2:3", "80:"]) expect(() => portPair(bad)).toThrow(UsageError);
});
