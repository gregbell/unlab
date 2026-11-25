// Throwaway. How often a right implementation fails "20% loss over n frames is within three points".
const logFact = (() => {
	const t = [0];
	return (n: number) => {
		for (let i = t.length; i <= n; i++) t[i] = t[i - 1] + Math.log(i);
		return t[n];
	};
})();
const pmf = (n: number, k: number, p: number) => Math.exp(logFact(n) - logFact(k) - logFact(n - k) + k * Math.log(p) + (n - k) * Math.log(1 - p));
const outside = (n: number, p: number, d: number) => {
	let s = 0;
	for (let k = 0; k <= n; k++) if (Math.abs(k - n * p) > n * d + 1e-9) s += pmf(n, k, p);
	return s;
};
for (const p of [0.2, 0.36, 0.5]) for (const n of [1000, 2000, 4000, 10_000]) console.log(`p=${p} n=${n}: P(outside three points) = ${outside(n, p, 0.03).toExponential(2)}, one in ${(1 / outside(n, p, 0.03)).toExponential(1)}`);
for (const d of [0.03, 0.04, 0.05, 0.06]) console.log(`p=0.2 n=1000 d=${d}: ${outside(1000, 0.2, d).toExponential(2)}`);
// How well those tests catch a wrong loss: the chance that a cable losing `wrong` passes.
for (const n of [1000, 10_000]) for (const wrong of [0.15, 0.25, 0.36]) {
	let s = 0;
	for (let k = 0; k <= n; k++) if (Math.abs(k - n * 0.2) <= n * 0.03 + 1e-9) s += pmf(n, k, wrong);
	console.log(`a cable that loses ${wrong} passes n=${n} with probability ${s.toExponential(2)}`);
}
// sfc32, seeded by splitmix from one integer: does it fail as often as the binomial says?
export function sfc32(seed: number): () => number {
	let s = seed >>> 0;
	const next = () => {
		s = (s + 0x9e3779b9) | 0;
		let z = s ^ (s >>> 16);
		z = Math.imul(z, 0x21f0aaad);
		z ^= z >>> 15;
		z = Math.imul(z, 0x735a2d97);
		return (z ^ (z >>> 15)) >>> 0;
	};
	let a = next(), b = next(), c = next(), d = next();
	return () => {
		const t = (((a + b) | 0) + d) | 0;
		d = (d + 1) | 0;
		a = b ^ (b >>> 9);
		b = (c + (c << 3)) | 0;
		c = (c << 21) | (c >>> 11);
		c = (c + t) | 0;
		return (t >>> 0) / 4294967296;
	};
}
for (const [name, make] of [["Math.random", () => Math.random], ["sfc32(seed)", (i: number) => sfc32(i)]] as const) {
	let bad = 0;
	const T = 200_000;
	for (let i = 0; i < T; i++) {
		const r = make(i);
		let k = 0;
		for (let j = 0; j < 1000; j++) if (r() < 0.2) k++;
		if (Math.abs(k - 200) > 30) bad++;
	}
	console.log(`${name}: ${bad} of ${T} runs of 1000 outside (${((100 * bad) / T).toFixed(2)}%)`);
}
const counts = [1, 2, 3, 4, 5].map((seed) => { const r = sfc32(seed); let k = 0; for (let j = 0; j < 1000; j++) if (r() < 0.2) k++; return k; });
console.log("sfc32 seeds 1..5, lost of the first 1000:", counts.join(" "));
