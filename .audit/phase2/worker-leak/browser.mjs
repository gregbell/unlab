// Chromium with no Playwright between: one raw DevTools socket to the page, and no worker attached to, as in a
// person's browser. What its worker threads do is read from /proc, so this runs on Linux only.

import { spawn } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { chromiumExecutable } from "../../../test/support/chromium.ts";

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".json": "application/json" };

/** Serves a directory as a cross-origin isolated site. `rewrite` may change a script before it is sent. */
export function serve(dir, rewrite = (_path, body) => body) {
	const server = createServer((req, res) => {
		res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
		res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
		const { pathname } = new URL(req.url, "http://localhost");
		const path = pathname === "/" ? "/index.html" : pathname;
		res.setHeader("content-type", TYPES[extname(path)] ?? "application/octet-stream");
		try {
			const body = readFileSync(join(dir, path));
			res.end(extname(path) === ".js" ? rewrite(path, body.toString()) : body);
		} catch {
			res.statusCode = 404;
			res.end();
		}
	});
	return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ port: server.address().port, close: () => server.close() })));
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function launch() {
	const profile = mkdtempSync(join(tmpdir(), "unlab-worker-leak-"));
	const flags = ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--enable-features=WebMCP", "--no-first-run", "--no-sandbox", "--window-size=1440,900", "about:blank"];
	const chrome = spawn(chromiumExecutable() ?? (await import("playwright")).chromium.executablePath(), flags, { stdio: ["ignore", "ignore", "pipe"] });
	const port = await new Promise((resolve, reject) => {
		let said = "";
		chrome.stderr.on("data", (chunk) => {
			said += chunk;
			const found = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(said);
			if (found) resolve(Number(found[1]));
		});
		chrome.on("exit", () => reject(new Error(`Chromium ended: ${said.slice(-400)}`)));
	});
	const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
	const socket = new WebSocket(targets.find((target) => target.type === "page").webSocketDebuggerUrl);
	await new Promise((resolve) => socket.addEventListener("open", resolve));
	let nextId = 1;
	const waiting = new Map();
	socket.addEventListener("message", (event) => {
		const message = JSON.parse(event.data);
		const settle = waiting.get(message.id);
		if (!settle) return;
		waiting.delete(message.id);
		if (message.error) settle.reject(new Error(message.error.message));
		else settle.resolve(message.result);
	});
	const send = (method, params = {}) =>
		new Promise((resolve, reject) => {
			const id = nextId++;
			waiting.set(id, { resolve, reject });
			socket.send(JSON.stringify({ id, method, params }));
		});
	const evaluate = async (expression) => {
		const { result, exceptionDetails } = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
		if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
		return result.value;
	};
	const key = async (key, code, modifiers, windowsVirtualKeyCode) => {
		const event = { key, code, modifiers, windowsVirtualKeyCode, ...(key === "Enter" ? { text: "\r" } : {}) };
		await send("Input.dispatchKeyEvent", { type: "keyDown", ...event });
		await send("Input.dispatchKeyEvent", { type: "keyUp", ...event });
	};

	/** The renderers' threads that are workers, as the kernel lists them. */
	const workerThreads = () => {
		const threads = [];
		for (const pid of readdirSync("/proc")) {
			if (!/^\d+$/.test(pid)) continue;
			try {
				const command = readFileSync(`/proc/${pid}/cmdline`, "utf8");
				if (!command.includes(profile) || !command.includes("--type=renderer")) continue;
				for (const tid of readdirSync(`/proc/${pid}/task`)) {
					if (readFileSync(`/proc/${pid}/task/${tid}/comm`, "utf8").trim() === "DedicatedWorker") threads.push({ pid, tid });
				}
			} catch {
				// A process or thread that ended while it was read.
			}
		}
		return threads;
	};

	return {
		send,
		evaluate,
		workerThreads,
		async open(url) {
			await send("Page.enable");
			await send("Runtime.enable");
			await send("Page.navigate", { url });
		},
		/** A line in the lab's command bar, as a person types it. */
		async typed(line) {
			await key("/", "Slash", 2, 191);
			await sleep(250);
			await send("Input.insertText", { text: line });
			await key("Enter", "Enter", 0, 13);
		},
		async close() {
			chrome.kill("SIGKILL");
			await sleep(300);
			rmSync(profile, { recursive: true, force: true });
		},
	};
}

/**
 * A sleeping thread's stack without symbols: each word from the stack pointer up that points into code, as the
 * file it points into and its offset there. Two threads asleep in the same calls print the same list.
 */
export function stackPrint({ pid, tid }, limit = 16) {
	const maps = readFileSync(`/proc/${pid}/maps`, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [range, perms, offset, , , ...path] = line.split(/\s+/);
			const [lo, hi] = range.split("-").map((hex) => BigInt(`0x${hex}`));
			return { lo, hi, perms, offset: BigInt(`0x${offset}`), path: path.join(" ") };
		});
	const call = readFileSync(`/proc/${pid}/task/${tid}/syscall`, "utf8").trim().split(" ");
	if (call[0] === "running") return { tid, running: true };
	const sp = BigInt(call[call.length - 2]);
	const stack = maps.find((map) => sp >= map.lo && sp < map.hi);
	const code = maps.filter((map) => map.perms.includes("x"));
	const length = Number(stack.hi - sp > 1048576n ? 1048576n : stack.hi - sp);
	const words = Buffer.alloc(length);
	const memory = openSync(`/proc/${pid}/mem`, "r");
	let read = 0;
	try {
		read = readSync(memory, words, 0, length, sp);
	} finally {
		closeSync(memory);
	}
	const frames = [];
	for (let at = 0; at + 8 <= read && frames.length < limit; at += 8) {
		const word = words.readBigUInt64LE(at);
		const map = code.find((map) => word >= map.lo && word < map.hi);
		if (map) frames.push(`${map.path === "" ? "jit" : map.path.split("/").pop()}+0x${(word - map.lo + map.offset).toString(16)}`);
	}
	// 202 is futex. Its fourth argument is the timeout: none for a thread with nothing to wake for.
	return { tid, syscall: call[0], sleeps: call[0] !== "202" ? undefined : call[4] === "0x0" ? "until woken" : "until a time", frames };
}
