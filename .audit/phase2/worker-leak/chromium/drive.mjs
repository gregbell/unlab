// Runs rounds of chromium/index.html and counts the worker threads each leaves. No part of unLAB is in it.
//
//   node .audit/phase2/worker-leak/chromium/drive.mjs [rounds] ['{"wait":"idle","first":true,"busy":50}' ...]
//
// With no options it runs the set that results/chromium.txt has.

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, serve, sleep, stackPrint } from "../browser.mjs";

const [rounds = "20", ...given] = process.argv.slice(2);
const SET = [
	// B is idle and ends at once. A ends it, and is ended while it is busy: both threads stay.
	{ wait: "idle", first: true, busy: 50 },
	// The same with A not busy, with the page a moment later, and with B ended only with A.
	{ wait: "idle", first: true, busy: 0 },
	{ wait: "idle", first: true, busy: 50, delay: 200 },
	{ wait: "idle", first: false, busy: 50 },
	{ wait: "idle", first: false, busy: 300 },
	// B cannot end by itself, so Chromium ends it by force after two seconds.
	{ wait: "forever", first: true, busy: 50 },
	{ wait: "forever", first: false, busy: 50 },
	{ wait: "timed", first: false, busy: 300 },
	{ wait: "spin", first: false, busy: 50 },
];
const set = given.length > 0 ? given.map((text) => JSON.parse(text)) : SET;

const site = await serve(dirname(fileURLToPath(import.meta.url)));
try {
	for (const options of set) {
		const browser = await launch();
		try {
			await browser.open(`http://127.0.0.1:${site.port}/`);
			await sleep(500);
			let left = 0;
			let leaks = 0;
			const took = [];
			for (let round = 1; round <= Number(rounds); round++) {
				await browser.evaluate(`round(${JSON.stringify(options)})`);
				const since = Date.now();
				while (browser.workerThreads().length > left && Date.now() - since < 3500) await sleep(25);
				took.push(Date.now() - since);
				const threads = browser.workerThreads();
				if (threads.length > left) {
					leaks++;
					if (leaks === 1) for (const thread of threads.slice(left)) console.log("  ", JSON.stringify(stackPrint(thread)));
				}
				left = threads.length;
			}
			console.log(`${JSON.stringify(options)}: ${leaks} of ${rounds} rounds left threads, ${left} in all; ms until they had gone: ${took.join(" ")}`);
		} finally {
			await browser.close();
		}
	}
} finally {
	site.close();
}
process.exit(0);
