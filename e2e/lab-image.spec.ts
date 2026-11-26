import { appendFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { chromiumExecutable } from "../test/support/chromium.ts";
import { root, typed } from "./lab.ts";

test.use({
	launchOptions: { executablePath: chromiumExecutable(), args: ["--enable-features=WebMCP"] },
});

async function openLab(page: Page): Promise<void> {
	await page.goto("/?layout=classic");
	await expect(page.getByRole("heading", { name: "Your Linux lab in a tab." })).toBeVisible();
}

const ready = (page: Page, text: string) => expect(page.getByText(text)).toBeVisible({ timeout: 60_000 });

const PROGRAMS = "tcpdump curl dig ssh sshd nginx strace sfdisk parted mkfs.ext4";

test("a lab machine with no network has the tools, and keeps a disk that it partitions and formats", async ({
	page,
}) => {
	await openLab(page);
	await typed(page, "spawn 1 lab --no-net --no-gateway --extra-disk 1");
	await ready(page, "1 of 1 ready");

	expect(await root(page, 1, "ip -V")).toContain("iproute2");
	expect((await root(page, 1, `command -v ${PROGRAMS.replaceAll(" ", "; command -v ")}`)).split("\n")).toHaveLength(10);

	await root(page, 1, 'printf "label: gpt\\n,\\n" | sfdisk -q /dev/wdc && mkfs.ext4 -q /dev/wdc1');
	await root(page, 1, "mount /dev/wdc1 /mnt && echo filed > /mnt/note && sync");
	await page.waitForTimeout(4000);
	await page.reload();
	await ready(page, "1 of 1 ready");
	// The kernel says that it mounted it, on the console that the command runs in.
	await root(page, 1, "mount /dev/wdc1 /mnt");
	expect(await root(page, 1, "cat /mnt/note")).toBe("filed");
});

test("packages install on a lab machine that has the gateway", async ({ page }) => {
	await openLab(page);
	await typed(page, "spawn 1 lab");
	await ready(page, "1 of 1 ready");
	await root(page, 1, "apk add --quiet tree && tree --version");
});

test("a lab machine boots about as fast as an Alpine one", async ({ page }) => {
	const boots: Record<"alpine" | "lab", number[]> = { alpine: [], lab: [] };
	await openLab(page);
	// In turn, so that what else the host does falls on both. The first of each also fetches its image.
	for (let n = 1; n <= 8; n++) {
		const image = n % 2 === 1 ? "alpine" : "lab";
		await typed(page, `spawn 1 ${image} --name ${image}-${n} --no-gateway`);
		const fact = page.locator("unlab-machine-details").getByText(/^ready · \d+ ms$/);
		await page.keyboard.press("Escape");
		await typed(page, `focus ${image}-${n}`);
		await expect(fact).toBeVisible({ timeout: 60_000 });
		boots[image].push(Number(/\d+/.exec((await fact.textContent()) ?? "")?.[0]));
		await typed(page, `rm ${image}-${n}`);
		await page.getByRole("button", { name: `Remove ${image}-${n}` }).click();
		await expect(page.getByText(`${image}-${n}`, { exact: true })).toHaveCount(0);
	}
	const fastest = (image: "alpine" | "lab") => Math.min(...boots[image]);
	const summary = `Boot to prompt, ms: alpine ${boots.alpine.join(", ")} · lab ${boots.lab.join(", ")}`;
	test.info().annotations.push({ type: "boot", description: summary });
	if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
	console.log(summary);
	expect(fastest("lab"), summary).toBeLessThan(fastest("alpine") * 2);
});
