let b;
onmessage = (event) => {
	if (event.data.wait) {
		b = new Worker("b.js");
		b.onmessage = () => postMessage("started");
		b.postMessage(event.data);
		return;
	}
	if (event.data.first) b.terminate();
	postMessage("told");
	// The page's terminate() and the news that B has gone both arrive while this thread is busy.
	const until = performance.now() + event.data.busy;
	while (performance.now() < until);
};
