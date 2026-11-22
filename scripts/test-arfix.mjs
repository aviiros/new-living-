import fs from 'fs';import zlib from 'zlib';
await import(''+new URL('../web-src',import.meta.url).pathname+'/ar-fix.js');
const set=new Set(zlib.gunzipSync(fs.readFileSync(''+new URL('../web-src',import.meta.url).pathname+'/ar-words.txt.gz')).toString().split('\n'));
const F=globalThis.liArFixMake(set);
const words=[...set].filter(w=>w.length>=5&&w.length<=9);
// corruption test: swap one letter with a look-alike
const G=['بتثني','جحخ','دذ','رز','سش','صض','طظ','عغ','فق'];let rec=0,tot=0,wrong=0,same=0;
let seed=7;const rnd=()=>(seed=(seed*1103515245+12345)&0x7fffffff)/0x7fffffff;
for(let n=0;n<4000;n++){const w=words[Math.floor(rnd()*words.length)];const pos=[...w].map((c,i)=>[c,i]).filter(([c])=>G.some(g=>g.includes(c)));if(!pos.length)continue;
 const [c,i]=pos[Math.floor(rnd()*pos.length)];const g=G.find(g=>g.includes(c)).replace(c,'');const bad=w.slice(0,i)+g[Math.floor(rnd()*g.length)]+w.slice(i+1);
 if(set.has(bad)||F.known(bad)){same++;continue}tot++;const f=F.fix(bad);if(f===w)rec++;else if(f!==bad)wrong++;}
console.log({tot,recovered:rec,changedWrong:wrong,leftAlone:tot-rec-wrong,skippedBecauseStillValidWord:same});
// clean text: how many real words get changed?
const clean='الحياة جميلة والعلم نور هذه المدرسة الكبيرة مرحبا بكم في الكتاب الجديد الذي كتبه المؤلف عن تاريخ الحضارة الإسلامية وأثرها في العالم';
console.log(F.fix(clean)===clean?'clean text unchanged':F.fix(clean));
