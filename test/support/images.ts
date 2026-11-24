import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * An image `npm run distros` mirrored and checked. unkernel's fetchDistro()
 * downloads instead, and two machines that start on an empty cache race to
 * rename the same partial file.
 */
export function imagePath(name: string): string {
	const path = fileURLToPath(new URL(`../../public/distros/${name}.erofs`, import.meta.url));
	if (!existsSync(path)) throw new Error(`No ${name} image. Run: npm run distros -- ${name}`);
	return path;
}
