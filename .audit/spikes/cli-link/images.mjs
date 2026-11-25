// Throwaway. What each image has for SSH, copying and HTTPS, and whether the built programs run on it.   node images.mjs
import { readFileSync } from "node:fs";
import { createKernel } from "unkernel/node";

const root = new URL("../../../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root));
for (const name of ["alpine", "debian", "lab"]) {
	const vm = await createKernel({ distro: new URL(`public/distros/${name}.erofs`, root).pathname, memoryMiB: 256 });
	const sh = async (script, input) => {
		const r = await vm.exec("/bin/sh", ["-c", script], { user: "root", input });
		return `${r.stdout}${r.stderr}`.trim();
	};
	console.log(`== ${name}`);
	console.log(await sh('for b in curl wget rsync scp ssh sshd bash openssl nginx sha256sum; do printf "%s=%s " $b "$(command -v $b || echo -)"; done'));
	console.log(await sh("ls -la /etc/ssl/certs 2>&1 | head -3; grep -E '^(root|user):' /etc/passwd; cat /etc/shells 2>&1 | tr '\\n' ' '; mount | grep -E ' /run '; ip -br addr show lo"));
	await sh("mkdir -p /run/unlab-ssh");
	for (const p of ["dropbear", "sftp-server", "rsync"]) {
		const t = performance.now();
		const out = await sh(`cat > /run/unlab-ssh/${p} && chmod 755 /run/unlab-ssh/${p} && sha256sum /run/unlab-ssh/${p} | cut -c1-12`, read(`public/ssh/${p}`));
		console.log(p, out, `${Math.round(performance.now() - t)} ms`);
	}
	console.log(await sh("/run/unlab-ssh/dropbear -V 2>&1; /run/unlab-ssh/rsync --version | head -1; echo | /run/unlab-ssh/sftp-server -Q requests | head -2 | tr '\\n' ' '"));
	vm.stop();
}
process.exit(0);
