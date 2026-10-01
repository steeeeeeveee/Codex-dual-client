import {renderMessageBody} from '/static/markdown.mjs';
// The browser inspector injects one blocked style even on csp.html (no renderer).
// Keep that baseline visible separately; never suppress a violation in app code.
const violations=[],inspector=[];document.addEventListener('securitypolicyviolation',event=>{
  const baseline=event.violatedDirective==='style-src-elem'&&!event.sourceFile&&event.lineNumber===135;
  (baseline?inspector:violations).push(`${event.violatedDirective} ${event.sourceFile}:${event.lineNumber} ${event.blockedURI}`);
  if(!baseline)document.querySelector('#errors').textContent='正文渲染错误：'+violations.join(', ');
});
const source=await(await fetch('/tests/fixtures/sample.md')).text();
const shells=[];
for(const width of [320,390,430,740]){
  const shell=document.createElement('section');shell.className='mobile-shell width-'+width;
  const title=document.createElement('p');title.className='sample-title';title.textContent=width+' px 屏幕';
  const article=document.createElement('article');article.className='message';
  const role=document.createElement('div');role.className='role';role.append(document.createTextNode('Codex'));
  const thinking=document.createElement('span');thinking.className='thinking';thinking.hidden=true;role.append(thinking);
  const body=document.createElement('div');body.className='body';article.append(role,body);shell.append(title,article);document.querySelector('#samples').append(shell);shells.push({shell,body,thinking});
}
function report(){
  const results=[];
  for(const {shell,body} of shells){const width=shell.className.match(/width-(\d+)/)[1];results.push(width+' px '+(shell.scrollWidth<=shell.clientWidth+1?'无页面溢出':'溢出！'));}
  const math=shells[0].body.querySelector('.katex');const strut=math?.querySelector('.katex-strut');
  const font=document.fonts.check('16px KaTeX_Main'),layout=strut&&parseFloat(getComputedStyle(strut).height)>0;
  document.querySelector('#checks').textContent=results.join('；')+'；本地公式字体 '+(font?'通过':'失败')+'；公式布局 '+(layout?'通过':'失败')+'；正文渲染违规 '+violations.length+'；浏览器检查基线提示 '+inspector.length;
}
async function full(){for(const {body,thinking} of shells){renderMessageBody(body,source);thinking.hidden=true;}await document.fonts.ready;requestAnimationFrame(report);}
let generation=0;
document.querySelector('#complete').onclick=()=>{generation++;full();};
document.querySelector('#stream').onclick=async()=>{
  const key=++generation;
  for(let i=0;i<=source.length;i+=45){if(key!==generation)return;for(const {body,thinking} of shells){thinking.hidden=false;thinking.textContent='正在思考';renderMessageBody(body,source.slice(0,i));}await new Promise(resolve=>setTimeout(resolve,35));}
  if(key===generation)full();
};
await full();
