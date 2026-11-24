import { fetchRoutes } from "unkernel";

function repository(base: string, paths: readonly string[]) {
	return async (request: Request) => {
		const { pathname } = new URL(request.url);
		// Keep the path inside the repository even on mirrors that decode escaped separators.
		if (/%(?:2f|5c|25)/i.test(pathname) || !paths.some((prefix) => pathname.startsWith(prefix))) {
			return new Response(null, { status: 404 });
		}
		const options: RequestInit = {
			method: request.method,
			credentials: "omit",
			referrerPolicy: "no-referrer",
			redirect: "error",
			signal: request.signal,
		};
		const url = base + pathname;
		const range = request.headers.get("Range");
		// An If-Range validator must travel with the Range or the guest may splice
		// different file versions. Serve a full response for conditional resumes.
		if (!range || request.headers.has("If-Range")) return fetch(url, options);
		const response = await fetch(url, { ...options, headers: { Range: range } });
		if (response.status !== 206 || response.headers.has("Content-Range")) return response;
		// Some mirrors allow CORS but hide Content-Range from the browser.
		await response.body?.cancel();
		return fetch(url, options);
	};
}

export function packageBackend() {
	return fetchRoutes(undefined, {
		"dl-cdn.alpinelinux.org": repository("https://repo.c48.uk", ["/alpine/"]),
		"deb.debian.org": repository("https://mirror.unkernel.dev/deb", ["/debian/", "/debian-security/"]),
	});
}

// fetchRoutes speaks HTTP inside the guest. The browser uses HTTPS outside it.
// Migrate only stock HTTPS entries. Subsequent edits to the configured repos survive reboot.
export const alpinePackageSetup = String.raw`set -e
repos=/etc/apk/repositories
if [ -f "$repos" ] && grep -q '^https://dl-cdn\.alpinelinux\.org/alpine/' "$repos"; then
  sed -i -e 's|^https://dl-cdn\.alpinelinux\.org/alpine/\(v[0-9.]*\)/main$|http://dl-cdn.alpinelinux.org/alpine/\1 main community|' \
         -e 's|^https://dl-cdn\.alpinelinux\.org/alpine/|http://dl-cdn.alpinelinux.org/alpine/|' "$(readlink -f "$repos")"
fi`;
