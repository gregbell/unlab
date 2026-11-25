// Throwaway. node summarise.mjs results/storm3.txt: median and range of each variant.
import fs from 'node:fs';
const t=fs.readFileSync(process.argv[2],'utf8').split(/^run \d+ /m).slice(1);const by={};
const q=(a)=>{a=a.filter(x=>Number.isFinite(x)).sort((x,y)=>x-y);return a.length?`${a[a.length>>1]} [${a[0]}-${a[a.length-1]}]`:'none'};
const pats={hops:/hops\/s (\d+)/,paints:/paints\/s (\d+)/,gapMax:/gap max (\d+)/,evalMax:/evaluate max (\d+)/,echo:/guest echo (\d+)/,pingGot:/during: (\d+)\/20/,pingP50:/during: \d+\/20 p50 ([\d.]+)/,rss0:/RSS (\d+)/,rssLast:/(\d+) MB each/,looped:/looped\/s (\d+)/,mainCpu:/MAIN ([\d.]+)/,worker1:/Worker ([\d.]+)/,full:/"full":(\d+)/,storm:/"storm":(\d+)/,over:/last looped frame (\d+)/,heal:/ping (\d)\/3/,healMs:/done (\d+) ms/};
for(const b of t){const n=b.split('\n')[0];for(const k in pats){const m=pats[k].exec(b);((by[n]??={})[k]??=[]).push(m?Number(m[1]):k==='mainCpu'?0.03:NaN)}if(/nicDropped \[.*?\]/.test(b))(by[n].nic??=[]).push(Math.max(...JSON.parse(/nicDropped (\[.*?\])/.exec(b)[1])));(by[n].vm??=[]).push((b.match(/no answer/g)||[]).length)}
for(const n in by){console.log(n,'n='+by[n].hops.length);for(const k in by[n])console.log('   ',k,q(by[n][k]))}
