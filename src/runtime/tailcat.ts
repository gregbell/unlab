import type { FromSharedGuest, FromTailcat, ToSharedGuest, ToTailcat } from "./tailcat-protocol.ts";

export type TailcatState =
	| { kind: "starting" }
	| { kind: "ready"; code: string }
	| { kind: "failed"; reason: string }
	| { kind: "stopped" };

export interface TailcatOptions {
	key: string;
	connect(port: MessagePort): boolean;
	onState(state: TailcatState): void;
}

export function startTailcat({ key, connect, onState }: TailcatOptions): { stop(): void } {
	let stopped = false;
	let worker: Worker | undefined;
	let code: string | undefined;
	const channel = new MessageChannel();
	const toGuest = (message: ToSharedGuest) => channel.port1.postMessage(message);
	const toWorker = (message: ToTailcat) => worker?.postMessage(message);
	const finish = (state: TailcatState) => {
		if (stopped) return;
		stopped = true;
		toGuest({ type: "stop" });
		if (worker) {
			const closing = worker;
			const timeout = setTimeout(() => closing.terminate(), 3000);
			closing.onmessage = ({ data }) => {
				if (data.type !== "stopped") return;
				clearTimeout(timeout);
				closing.terminate();
			};
			toWorker({ type: "stop" });
		}
		channel.port1.close();
		channel.port2.close();
		onState(state);
	};
	onState({ kind: "starting" });
	try {
		const authorizedKey = parseSshPublicKey(key);
		if (!connect(channel.port2)) throw new Error("The selected machine is no longer running.");
		worker = new Worker(new URL(`${import.meta.env.BASE_URL}tailcat/worker.js`, location.href));
		worker.onerror = () => finish({ kind: "failed", reason: "The SSH sharing worker could not start." });
		worker.onmessage = ({ data: message }: MessageEvent<FromTailcat>) => {
			if (stopped) return;
			if (message.type === "error") {
				finish({ kind: "failed", reason: message.message });
				return;
			}
			if (message.type === "ready") {
				toGuest({
					type: "configure",
					keys: { hostKey: message.hostKey, authorizedKey },
					programs: new URL(`${import.meta.env.BASE_URL}ssh/`, location.href).href,
				});
				code = message.code;
			} else toGuest(message);
		};
		channel.port1.onmessage = ({ data: message }: MessageEvent<FromSharedGuest>) => {
			if (stopped) return;
			if (message.type === "configured") {
				if (code) onState({ kind: "ready", code });
			} else if (message.type === "error") finish({ kind: "failed", reason: message.message });
			else if (message.type === "stop") finish({ kind: "stopped" });
			else toWorker(message);
		};
		toWorker({ type: "start" });
	} catch (error) {
		finish({ kind: "failed", reason: error instanceof Error ? error.message : String(error) });
	}
	return { stop: () => finish({ kind: "stopped" }) };
}

export function parseSshPublicKey(input: string): string {
	const key = input.trim();
	const match = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) ([A-Za-z0-9+/]+={0,2})(?: [^\r\n]*)?$/.exec(
		key,
	);
	const invalid = () => new Error("Paste one valid OpenSSH Ed25519, RSA, or ECDSA public key.");
	if (!match) throw invalid();
	const algorithm = match[1];
	let bytes: Uint8Array;
	try {
		bytes = Uint8Array.from(atob(match[2] ?? ""), (character) => character.charCodeAt(0));
	} catch {
		throw invalid();
	}
	let offset = 0;
	const field = () => {
		if (offset + 4 > bytes.length) throw invalid();
		const length = new DataView(bytes.buffer).getUint32(offset);
		offset += 4;
		if (length > bytes.length - offset) throw invalid();
		const value = bytes.slice(offset, offset + length);
		offset += length;
		return value;
	};
	const text = (value: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(value);
	try {
		if (text(field()) !== algorithm) throw invalid();
		if (algorithm === "ssh-ed25519") {
			if (field().length !== 32) throw invalid();
		} else if (algorithm === "ssh-rsa") {
			const exponent = field();
			const modulus = field();
			if (!exponent.length || exponent.length > 8 || modulus.length < 128 || modulus.length > 1025) throw invalid();
		} else {
			const curve = text(field());
			const point = field();
			const size = curve === "nistp256" ? 65 : curve === "nistp384" ? 97 : curve === "nistp521" ? 133 : 0;
			if (algorithm !== `ecdsa-sha2-${curve}` || point.length !== size || point[0] !== 4) throw invalid();
		}
		if (offset !== bytes.length) throw invalid();
	} catch {
		throw invalid();
	}
	return key;
}
