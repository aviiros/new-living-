// Scanned PDF (pictures only): the reader's lines become the text of the page, so search, highlight and getTextContent (used by listening and translation) work.
const {chromium}=require('playwright');const fs=require('fs');const http=require('http');const path=require('path');const os=require('os');
const root=os.tmpdir()+'/pdfs-'+process.pid;fs.mkdirSync(root,{recursive:true});fs.cpSync(__dirname+'/../web-src/pdfjs',root+'/pdfjs',{recursive:true});fs.copyFileSync(__dirname+'/testdata/pdf-plain.pdf',root+'/plain.pdf');
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript','.pdf':'application/pdf'};
const srv=http.createServer((q,r)=>{const f=path.join(root,decodeURIComponent(q.url.split('?')[0]));fs.readFile(f,(e,b)=>{if(e){r.writeHead(404);r.end();return}r.writeHead(200,{'content-type':types[path.extname(f)]||'application/octet-stream'});r.end(b)})}).listen(0);
const port=srv.address().port,pa=fs.readFileSync(__dirname+'/../platform/platform-android.js','utf8');
const fnOf=(n)=>{const a=pa.indexOf('function '+n+'()');let d=0,i=pa.indexOf('{',a);for(let j=i;j<pa.length;j++){if(pa[j]=='{')d++;else if(pa[j]=='}'){d--;if(d==0)return pa.slice(a,j+1)}}};
const viewer=(file,extra)=>{let h=fs.readFileSync(__dirname+'/../web-src/pdfviewer.html','utf8').replace(/book:\/\/__ID__\/__pdfjs\//g,'/pdfjs/').replace(/book:\/\/__ID__\/__file/g,'/'+file).replace(/__ID__/g,'x').replace(/__TITLE__/g,'t').replace(/__LANG__/g,'ar');
 const pre=`<script>window.__LI=${JSON.stringify({ui:'ar',id:'x'+file,url:'/'+file,base:'/pdfjs/'})};window.__msgs=[];addEventListener('message',e=>{if(e.data&&e.data.liBook)__msgs.push(e.data)});${extra||''}<\/script>`;
 return h.replace(/(<script src="[^"]*pdf\.min\.js"><\/script>)/,m=>pre+m+`<script>(${fnOf('PDFN')})();<\/script>`)};
(async()=>{const br=await chromium.launch();const fail=[];const ck=(n,c)=>{if(!c)fail.push(n)};
// 1. a picture of page 1 of the plain PDF, and where its lines are
fs.writeFileSync(root+'/a.html',viewer('plain.pdf'));
let pg=await br.newPage({viewport:{width:900,height:900}});await pg.goto(`http://127.0.0.1:${port}/a.html`);await pg.waitForFunction(()=>document.querySelectorAll('.pg canvas').length>=1,null,{timeout:20000});await pg.waitForTimeout(1200);
const src=await pg.evaluate(async()=>{const c=document.querySelector('.pg canvas');const p=await __pdoc.getPage(1);const v=p.getViewport({scale:1});const tc=await p.getTextContent();
 const rows=tc.items.filter(i=>i.str.trim()).map(i=>({t:i.str,x:i.transform[4]/v.width,y:(v.height-i.transform[5]-i.height*0.85)/v.height,w:i.width/v.width,h:i.height*1.1/v.height}));return {png:c.toDataURL('image/png'),rows,pw:v.width,ph:v.height}});await pg.close();
// 2. a PDF made only of that picture
pg=await br.newPage();await pg.setContent(`<style>@page{size:${src.pw}px ${src.ph}px;margin:0}body{margin:0}img{width:${src.pw}px;height:${src.ph}px;display:block}</style><img src="${src.png}">`);await pg.pdf({path:root+'/scan.pdf',width:src.pw+'px',height:src.ph+'px',printBackground:true});await pg.close();
// 3. the scanned PDF with a stand-in for the library's reader (it answers with the true lines)
fs.writeFileSync(root+'/b.html',viewer('scan.pdf',`window.__ocrCalls=0;window.liOcrLines=function(cv){window.__ocrCalls++;return Promise.resolve({script:'arabic',rows:${JSON.stringify(src.rows)}})};`));
pg=await br.newPage({viewport:{width:900,height:900}});const errs=[];pg.on('pageerror',e=>errs.push(String(e)));await pg.goto(`http://127.0.0.1:${port}/b.html`);
await pg.waitForFunction(()=>document.querySelectorAll('.pg canvas').length>=1,null,{timeout:20000});await pg.waitForTimeout(3000);
const r={};r.spans=await pg.evaluate(()=>document.querySelectorAll('.tl span').length);r.calls=await pg.evaluate(()=>__ocrCalls);
r.tc=await pg.evaluate(async()=>{const p=await __pdoc.getPage(1);const tc=await p.getTextContent();return tc.items.map(i=>i.str).join(' ').slice(0,60)});
await pg.evaluate(()=>postMessage({liCmd:'init',annots:[]},'*'));await pg.evaluate(()=>postMessage({liCmd:'find',q:'مرحبا'},'*'));await pg.waitForTimeout(2500);
r.find=await pg.evaluate(()=>({fl:document.querySelectorAll('.fl i').length,cur:document.querySelectorAll('.fl i.cur').length}));
await pg.evaluate(()=>{const sp=document.querySelector('.tl span');const rg=document.createRange();rg.selectNodeContents(sp);const s=getSelection();s.removeAllRanges();s.addRange(rg)});await pg.waitForTimeout(700);
await pg.click('#lipop button[data-a="hl"]');await pg.waitForTimeout(400);
r.hl=await pg.evaluate(()=>({layer:document.querySelectorAll('.hl i').length,a:__msgs.filter(m=>m.type==='annots').pop().annots.filter(a=>a.type==='hl').length}));
ck('text layer from reader',r.spans>=3);ck('reader called once per page',r.calls>=1&&r.calls<=3);ck('getTextContent gets the text',/\S/.test(r.tc));ck('find on scanned',r.find.cur>=1);ck('highlight on scanned',r.hl.layer>=1&&r.hl.a===1);ck('no page errors',errs.length===0);
console.log(JSON.stringify(r),errs.slice(0,3));console.log(fail.length?'FAIL: '+fail.join(', '):'PASS');await br.close();srv.close();process.exit(fail.length?1:0)})();
