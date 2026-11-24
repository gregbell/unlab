// Static hosts such as GitHub Pages cannot configure response headers. Scope
// these to this application so the kernel workers can share SMP memory.
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (event) => {
	const request = event.request;
	if (request.method !== "GET" || !request.url.startsWith(self.registration.scope)) return;
	event.respondWith(
		(async () => {
			const response = await fetch(request);
			if (response.type === "opaque" || response.status === 0) return response;
			const headers = new Headers(response.headers);
			headers.set("Cross-Origin-Opener-Policy", "same-origin");
			headers.set("Cross-Origin-Embedder-Policy", "require-corp");
			return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
		})(),
	);
});
