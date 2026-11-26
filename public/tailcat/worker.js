/* global Go, importScripts */
importScripts("wasm_exec.js");

async function loadTailcat() {
	const go = new Go();
	const ready = Promise.withResolvers();
	self.tailcatLoaded = ready.resolve;
	const response = await fetch("tailcat.wasm.gz");
	if (!response.ok) throw new Error(`Tailcat could not load: HTTP ${response.status}.`);
	const body = await response.blob();
	// Some static hosts send .gz as a file, others set Content-Encoding and the browser decodes it.
	const magic = new Uint8Array(await body.slice(0, 2).arrayBuffer());
	const decoded =
		magic[0] === 0x1f && magic[1] === 0x8b
			? new Response(body.stream().pipeThrough(new DecompressionStream("gzip")))
			: body;
	const { instance } = await WebAssembly.instantiate(await decoded.arrayBuffer(), go.importObject);
	void go.run(instance).catch((error) => self.postMessage({ type: "error", message: String(error) }));
	await ready.promise;
}

let loading;
self.onmessage = async ({ data }) => {
	try {
		loading ??= loadTailcat();
		await loading;
		self.tailcatMessage(data);
	} catch (error) {
		self.postMessage({ type: "error", message: String(error) });
	}
};
