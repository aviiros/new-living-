const {chromium}=require('playwright');const fs=require('fs');const http=require('http');const path=require('path');
const root=require('os').tmpdir()+'/pdft-'+process.pid;fs.mkdirSync(root,{recursive:true});fs.cpSync(__dirname+'/../web-src/pdfjs',root+'/pdfjs',{recursive:true});fs.copyFileSync(__dirname+'/testdata/pdf-glyphs.pdf',root+'/test.pdf');fs.copyFileSync(__dirname+'/testdata/pdf-plain.pdf',root+'/test2.pdf'),types={'.html':'text/html; charset=utf-8','.js':'text/javascript','.pdf':'application/pdf','.mjs':'text/javascript'};
const srv=http.createServer((q,r)=>{const f=path.join(root,decodeURIComponent(q.url.split('?')[0]));fs.readFile(f,(e,b)=>{if(e){r.writeHead(404);r.end();return}r.writeHead(200,{'content-type':types[path.extname(f)]||'application/octet-stream'});r.end(b)})}).listen(0);
const port=srv.address().port;
const pa=fs.readFileSync(__dirname+'/../platform/platform-android.js','utf8');
const fnOf=(n)=>{const a=pa.indexOf('function '+n+'()');let d=0,i=pa.indexOf('{',a);for(let j=i;j<pa.length;j++){if(pa[j]=='{')d++;else if(pa[j]=='}'){d--;if(d==0)return pa.slice(a,j+1)}}};
let html=fs.readFileSync(__dirname+'/../web-src/pdfviewer.html','utf8').replace(/book:\/\/__ID__\/__pdfjs\//g,'/pdfjs/').replace(/book:\/\/__ID__\/__file/g,'/'+(process.env.PDF||'test.pdf')).replace(/__ID__/g,'x').replace(/__TITLE__/g,'t').replace(/__LANG__/g,'ar');
const pre=`<script>window.__LI=${JSON.stringify({ui:'ar',id:'x',url:'/test.pdf',base:'/pdfjs/'})};window.__msgs=[];addEventListener('message',e=>{if(e.data&&e.data.liBook)__msgs.push(e.data)});window.LiNative={translate(){}};window.__TRU={};window.__TRS={ID:'x',NAMES:{en:'English',ar:'Arabic'},TX:new Proxy({},{get:()=>new Proxy({},{get:(t,k)=>String(k)})})};window.__spoken=[];addEventListener('error',e=>{console.error('ERRLOC '+e.filename+':'+e.lineno+':'+e.colno+' '+e.message)});window.SpeechSynthesisUtterance=function(t){this.text=t};Object.defineProperty(window,'speechSynthesis',{configurable:true,value:{speak(u){__spoken.push(u);setTimeout(()=>{u.onstart&&u.onstart();setTimeout(()=>u.onend&&u.onend(),2500)},10)},cancel(){},pause(){},resume(){},getVoices(){return[]},addEventListener(){}}});<\/script>`;
const post=`<script>(${fnOf('PDFG')})();<\/script><script>(${fnOf('PDFN')})();<\/script><script>(${fnOf('PDFX')})();<\/script>`;
html=html.replace(/(<script src="[^"]*pdf\.min\.js"><\/script>)/,m=>pre+m+post);
fs.writeFileSync(root+'/v.html',html);const fail=[];const ck=(n,c)=>{if(!c)fail.push(n)};
(async()=>{const br=await chromium.launch();const pg=await br.newPage({viewport:{width:900,height:900}});const errs=[];pg.on('pageerror',e=>errs.push(String(e)+(e.stack||'').slice(0,300)));pg.on('console',m=>{if(m.type()==='error')errs.push('console: '+m.text())});
await pg.goto(`http://127.0.0.1:${port}/v.html`);
await pg.waitForFunction(()=>document.querySelectorAll('.pg').length===3&&document.querySelectorAll('.pg canvas').length>=1,null,{timeout:20000});
await pg.waitForTimeout(1500);
const send=(m)=>pg.evaluate(m=>postMessage(m,'*'),m);
await send({liCmd:'init',annots:[]});
const r={};
r.spans=await pg.evaluate(()=>document.querySelectorAll('.tl span').length);
// find arabic
await send({liCmd:'find',q:'مرحبا'});await pg.waitForTimeout(1500);
r.find1=await pg.evaluate(()=>({fl:document.querySelectorAll('.fl i').length,cur:document.querySelectorAll('.fl i.cur').length,top:Math.round(document.getElementById('sc').scrollTop)}));
await send({liCmd:'find',q:'مرحبا'});await pg.waitForTimeout(1800);
r.find2=await pg.evaluate(()=>({cur:document.querySelectorAll('.fl i.cur').length,top:Math.round(document.getElementById('sc').scrollTop)}));
await send({liCmd:'find',q:'zebra'});await pg.waitForTimeout(1500);
r.zebra=await pg.evaluate(()=>({cur:document.querySelectorAll('.fl i.cur').length,top:Math.round(document.getElementById('sc').scrollTop)}));
await send({liCmd:'find',q:'qqqqq'});await pg.waitForTimeout(1500);
r.none=await pg.evaluate(()=>document.getElementById('litoast').textContent);
// bookmark
await send({liCmd:'bookmark'});await pg.waitForTimeout(400);
r.bm=await pg.evaluate(()=>({msgs:__msgs.filter(m=>m.type==='annots').pop(),bk:document.querySelectorAll('.bk').length}));
// listening player
await pg.click('#li-pl-btn');await pg.waitForTimeout(900);
r.pl=await pg.evaluate(()=>({shown:getComputedStyle(document.getElementById('li-pl')).display,spoken:__spoken.length,ctr:document.querySelectorAll('#li-pl button').length,sliders:document.querySelectorAll('#li-pl input[type=range]').length}));
await pg.click('#li-pl [data-a="nx"]');await pg.waitForTimeout(900);
r.pl.page=await pg.evaluate(()=>document.querySelector('#li-pl [data-r=pg]').textContent);
await pg.click('#li-pl [data-a="pp"]');await pg.waitForTimeout(200);r.pl.pp=await pg.evaluate(()=>document.querySelector('#li-pl [data-a=pp]').innerHTML);
await pg.screenshot({path:'/tmp/pv/pl.png'});await pg.click('#li-pl [data-a="mn"]');await pg.waitForTimeout(150);r.pl.mini=await pg.evaluate(()=>document.getElementById('li-pl').classList.contains('mini')&&getComputedStyle(document.querySelector('#li-pl [data-r=sp]')).display==='none'||document.getElementById('li-pl').classList.contains('mini'));await pg.click('#li-pl [data-a="x"]');await pg.waitForTimeout(200);r.pl.hidden=await pg.evaluate(()=>getComputedStyle(document.getElementById('li-pl')).display);
// toc
await pg.evaluate(()=>{document.getElementById('sc').scrollTop=0});await pg.waitForTimeout(500);
await send({liCmd:'toc'});await pg.waitForTimeout(800);
r.toc=await pg.evaluate(()=>__msgs.filter(m=>m.type==='toc').pop());
if(r.toc&&r.toc.items&&r.toc.items.length>1){const t0=await pg.evaluate(()=>document.getElementById('sc').scrollTop);await send({liCmd:'jump',id:r.toc.items.length-1});await pg.waitForTimeout(800);r.jump=await pg.evaluate(t=>({from:Math.round(t),to:Math.round(document.getElementById('sc').scrollTop)}),t0)}
// highlight by selection
await pg.evaluate(()=>{document.getElementById('sc').scrollTop=0});await pg.waitForTimeout(600);
await pg.evaluate(()=>{const sp=document.querySelector('.tl span');const rg=document.createRange();rg.selectNodeContents(sp);const s=getSelection();s.removeAllRanges();s.addRange(rg)});
await pg.waitForTimeout(700);
r.popup=await pg.evaluate(()=>document.getElementById('lipop').style.display+' | '+document.getElementById('lipop').textContent);
await pg.click('#lipop button[data-a="hl"]');await pg.waitForTimeout(400);
r.hl=await pg.evaluate(()=>({annots:__msgs.filter(m=>m.type==='annots').pop().annots.map(a=>({type:a.type,page:a.page,n:(a.rects||[]).length,q:(a.quote||'').slice(0,30)})),layer:document.querySelectorAll('.hl i').length}));
await pg.screenshot({path:'/tmp/pv/shot.png'});
// delete via panel command
const idh=await pg.evaluate(()=>__msgs.filter(m=>m.type==='annots').pop().annots.filter(a=>a.type==='hl')[0].id);
await send({liCmd:'delannot',id:idh});await pg.waitForTimeout(300);
r.del=await pg.evaluate(()=>({layer:document.querySelectorAll('.hl i').length,n:__msgs.filter(m=>m.type==='annots').pop().annots.length}));
ck('layer text',r.spans>5);ck('find arabic',r.find1.cur>=1);ck('find next moves',r.find2.cur>=1);ck('no result message',r.none&&r.none.length>3);ck('bookmark',r.bm.bk===1&&r.bm.msgs.annots[0].type==='bm');ck('highlight popup',/flex/.test(r.popup));ck('highlight saved',r.hl.layer>=1&&r.hl.annots.some(a=>a.type==='hl'&&a.n>=1));ck('delete',r.del.layer===0);ck('listen panel',r.pl.shown==='block'&&r.pl.spoken>=1&&r.pl.ctr===5&&r.pl.sliders===2&&r.pl.mini&&r.pl.hidden==='none'&&/M8 5.2/.test(r.pl.pp));ck('no page errors',errs.length===0);if(process.env.PDF==='test2.pdf'){ck('contents list',r.toc.items.length>=1)}else{ck('contents list',r.toc.items.length>=2&&r.jump&&r.jump.to>r.jump.from)}console.log(process.env.PDF,JSON.stringify(r),errs.slice(0,3));console.log(fail.length?'FAIL: '+fail.join(', '):'PASS');await br.close();srv.close();process.exit(fail.length?1:0)})();
