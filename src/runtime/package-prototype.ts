// Can the guest's stock package manager install from signed repositories
// using only HTTPS fetches from the browser?
import { fetchRoutes } from "unkernel";

function repository(base: string, paths: readonly string[]) {
	return (request: Request) => {
		const { pathname } = new URL(request.url);
		if (!paths.some((prefix) => pathname.startsWith(prefix))) return new Response(null, { status: 404 });
		const range = request.headers.get("Range");
		return fetch(base + pathname, {
			method: request.method,
			headers: range ? { Range: range } : {},
			credentials: "omit",
			redirect: "error",
			signal: request.signal,
		});
	};
}

export function packageBackend() {
	return fetchRoutes(undefined, {
		"dl-cdn.alpinelinux.org": repository("https://repo.c48.uk", ["/alpine/"]),
		"deb.debian.org": repository("https://mirror.unkernel.dev/deb", ["/debian/", "/debian-security/"]),
	});
}

// fetchRoutes speaks HTTP inside the guest. The browser uses HTTPS outside it.
// A bind mount changes apk's stock URL for this boot without editing its disk.
export const alpinePackageSetup = String.raw`set -e
sed -e 's|https://dl-cdn\.alpinelinux\.org/alpine/|http://dl-cdn.alpinelinux.org/alpine/|g' \
    -e 's|^\(http://dl-cdn\.alpinelinux\.org/alpine/v[0-9.]*\)/main$|\1 main community|' \
    /etc/apk/repositories > /run/unlab-apk-repositories
mount --bind /run/unlab-apk-repositories /etc/apk/repositories`;
