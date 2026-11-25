// Throwaway. Whether a page that Playwright drives is ever hidden or throttled when another page is in front.
import { chromium } from "playwright";
import { chromiumExecutable } from "../../../test/support/chromium.ts";
for (const [name, options] of [["default arguments", {}], ["throttling arguments removed", { ignoreDefaultArgs: ["--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"] }]] as const) {
	const browser = await chromium.launch({ executablePath: chromiumExecutable(), ...options, ignoreDefaultArgs: [...((options as { ignoreDefaultArgs?: string[] }).ignoreDefaultArgs ?? [])] });
	const context = await browser.newContext();
	const a = await context.newPage();
	await a.goto("data:text/html,<title>a</title>");
	const b = await context.newPage();
	await b.goto("data:text/html,<title>b</title>");
	await b.bringToFront();
	await new Promise((r) => setTimeout(r, 2000));
	console.log(name, await a.evaluate(async () => {
		const late: number[] = [];
		for (let i = 0; i < 8; i++) {
			const t = performance.now();
			await new Promise((r) => setTimeout(r, 100));
			late.push(Math.round(performance.now() - t - 100));
		}
		return `visibilityState=${document.visibilityState} 100 ms timers late by ${late}`;
	}));
	const cdp = await context.newCDPSession(a);
	await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: false });
	await b.bringToFront();
	await new Promise((r) => setTimeout(r, 2000));
	console.log(name, "focus emulation off:", await a.evaluate(async () => {
		const late: number[] = [];
		for (let i = 0; i < 4; i++) {
			const t = performance.now();
			await new Promise((r) => setTimeout(r, 100));
			late.push(Math.round(performance.now() - t - 100));
		}
		return `visibilityState=${document.visibilityState} late by ${late}`;
	}));
	await browser.close();
}
