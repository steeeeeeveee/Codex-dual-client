// Isolated regression scene: only the visual viewport shrinks, not CSS media
// queries or the layout viewport. This reproduces the geometry of iOS Safari.
const viewport=new EventTarget();
Object.assign(viewport,{height:innerHeight,offsetTop:0,pageTop:0,scale:1});
Object.defineProperty(window,'visualViewport',{value:viewport,configurable:true});
const link=document.createElement('link');link.rel='stylesheet';link.href='/tests/fixtures/ui-keyboard.css';document.head.append(link);
const keys=document.createElement('div');keys.id='fixtureKeyboard';keys.textContent='模拟键盘 · 布局视口保持原尺寸';keys.hidden=true;
document.body.append(keys);
// Exercise a burst of changing geometry, including duplicate Safari-style
// resize/scroll notifications. Counters are test-only and stay on this origin.
const nativeHeight=Object.getOwnPropertyDescriptor(Element.prototype,'scrollHeight');
let reads={prompt:0,chat:0},motion=0;
Object.defineProperty(Element.prototype,'scrollHeight',{...nativeHeight,get(){
  if(this.classList.contains('promptMeasure'))reads.prompt++;
  if(this.id==='chatScroll')reads.chat++;
  return nativeHeight.get.call(this);
}});
function animateKeyboard(open){
  const id=++motion,start=performance.now(),from=viewport.height,to=open?Math.round(innerHeight*.52):innerHeight;
  const samples=[];
  const sample=()=>{
    const dock=document.getElementById('composerDock'),content=document.querySelector('.chatContent');
    const message=document.querySelector('#history .message:last-child'),scroll=document.getElementById('chatScroll');
    samples.push({time:Math.round(performance.now()-start),dock:dock.getBoundingClientRect().y,
      first:document.querySelector('#history .body')?.getBoundingClientRect().y,last:message?.getBoundingClientRect().bottom,
      top:scroll.scrollTop,contentTransform:content.style.transform,root:document.getElementById('workspace').getBoundingClientRect().height});
  };
  sample();
  reads={prompt:0,chat:0};delete document.documentElement.dataset.keyboardReads;document.documentElement.dataset.keyboardPhase=open?'opening':'closing';
  keys.hidden=false;
  const frame=now=>{
    if(id!==motion)return;
    const progress=Math.min(1,(now-start)/300),ease=1-Math.pow(1-progress,3);
    viewport.height=Math.round(from+(to-from)*ease);keys.style.top=viewport.height+'px';
    viewport.dispatchEvent(new Event('resize'));viewport.dispatchEvent(new Event('scroll'));
    sample();
    if(progress<1)requestAnimationFrame(frame);
    else{
      keys.hidden=!open;document.documentElement.dataset.keyboardPhase=open?'open':'closed';
      setTimeout(()=>{if(id===motion){sample();document.documentElement.dataset.keyboardReads=JSON.stringify(reads);document.documentElement.dataset.keyboardSamples=JSON.stringify(samples);}},400);
    }
  };requestAnimationFrame(frame);
}
document.addEventListener('focusin',event=>{
  if(event.target.id!=='prompt')return;
  animateKeyboard(true);
});
document.addEventListener('focusout',event=>{
  if(event.target.id!=='prompt')return;
  animateKeyboard(false);
});
