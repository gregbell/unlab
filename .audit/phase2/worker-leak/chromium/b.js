onmessage = (event) => {
	const word = new Int32Array(new SharedArrayBuffer(4));
	postMessage("started");
	if (event.data.wait === "forever") Atomics.wait(word, 0, 0);
	else if (event.data.wait === "timed") for (;;) Atomics.wait(word, 0, 0, 50);
	else if (event.data.wait === "spin") for (;;);
};
