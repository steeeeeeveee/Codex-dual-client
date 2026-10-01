import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {KeyboardViewport} from '../static/keyboard_viewport.mjs';

// A scroll surface that clamps like a browser, with a deterministic frame clock.
function fixture(t,{natural=1500,reduced=false,glass=false}={}) {
  const dom=new JSDOM(readFileSync(new URL('../static/index.html',import.meta.url),'utf8'),{pretendToBeVisual:true});
  t.after(()=>dom.window.close());const win=dom.window,doc=win.document,$=id=>doc.getElementById(id);
  let now=0,id=0,position=0,reads=0;const frames=new Map(),timers=new Map();
  Object.defineProperty(win.performance,'now',{value:()=>now});
  win.requestAnimationFrame=fn=>{frames.set(++id,fn);return id;};win.cancelAnimationFrame=id=>frames.delete(id);
  win.setTimeout=(fn,delay)=>{timers.set(++id,{fn,at:now+delay});return id;};win.clearTimeout=id=>timers.delete(id);
  win.matchMedia=()=>({matches:reduced});
  Object.defineProperty(win,'innerHeight',{value:844,configurable:true});Object.defineProperty(win,'innerWidth',{value:390,configurable:true});
  const viewport=Object.assign(new win.EventTarget(),{height:844,pageTop:0,offsetTop:0,scale:1});Object.defineProperty(win,'visualViewport',{value:viewport});
  $('workspace').hidden=false;$('composerDock').style.paddingBottom='48px';
  Object.defineProperty($('composerDock'),'offsetHeight',{value:162,configurable:true});
  Object.defineProperty($('chatViewport'),'offsetTop',{value:64,configurable:true});
  const content=doc.querySelector('.chatContent'),scroll=$('chatScroll');
  Object.defineProperty(content,'scrollHeight',{get:()=>natural});
  const gutter=()=>glass?64+162:0;
  Object.defineProperty(scroll,'clientHeight',{get:()=>(parseFloat(scroll.style.height)||618)+gutter()});
  Object.defineProperty(scroll,'scrollHeight',{get:()=>{reads++;return Math.max(natural+gutter(),scroll.clientHeight);}});
  Object.defineProperty(scroll,'scrollTop',{get:()=>Math.min(position,Math.max(0,natural+gutter()-scroll.clientHeight)),set:value=>position=Math.max(0,Math.min(value,natural+gutter()-scroll.clientHeight))});
  const controller=new KeyboardViewport(doc);controller.viewport();
  const advance=milliseconds=>{
    now+=milliseconds;const callbacks=[...frames.values()];frames.clear();for(const fn of callbacks)fn(now);
    for(const [key,timer] of [...timers])if(timer.at<=now){timers.delete(key);timer.fn();}
  };
  const focus=()=>{$('prompt').focus();controller.viewport();};
  const open=(height=439)=>{focus();viewport.height=height;controller.viewport();};
  const close=()=>{$('prompt').blur();viewport.height=844;controller.viewport();};
  return {win,doc,$,viewport,controller,content,scroll,advance,open,close,focus,reads:()=>reads,setNatural:value=>{natural=value;}};
}

test('glass gutters preserve old reading position, bottom scroll range and keyboard endpoints',t=>{
 const {controller,content,scroll,advance,open,close,$}=fixture(t,{glass:true});
 assert.equal(scroll.clientHeight,844);assert.equal(scroll.scrollHeight,1726);scroll.scrollTop=250;
 assert.equal($('workspace').style.getPropertyValue('--chat-header-height'),'64px');
 assert.equal($('workspace').style.getPropertyValue('--chat-dock-height'),'162px');
 open();advance(240);assert.equal(scroll.scrollTop,250);assert.equal(content.style.transform,'');assert.equal(controller.lift,363);
 close();advance(240);assert.equal(scroll.scrollTop,250);assert.equal(scroll.clientHeight,844);
 scroll.scrollTop=882;assert.equal(controller.atBottom(),true);open();advance(240);assert.equal(scroll.scrollTop,1245);assert.equal(controller.atBottom(),true);
 close();advance(240);assert.equal(scroll.scrollTop,882);assert.equal(controller.atBottom(),true);
});

test('scroll to bottom moves smoothly, reaches new streamed content and resumes following',t=>{
 const {controller,scroll,advance,setNatural}=fixture(t,{glass:true});scroll.scrollTop=250;
 controller.scrollToBottom();assert.equal(scroll.scrollTop,250);assert.equal(controller.followsChat(),false);
 advance(160);assert(scroll.scrollTop>250&&scroll.scrollTop<882);
 setNatural(1700);advance(160);
 assert.equal(scroll.scrollTop,1082);assert.equal(controller.atVisibleBottom(),true);assert.equal(controller.followsChat(),true);
 assert.equal(controller.bottomMotion,null);
});

test('manual reading and conversation changes cancel a pending bottom animation',t=>{
 const {controller,scroll,advance,win}=fixture(t);scroll.scrollTop=200;controller.scrollToBottom();advance(80);
 scroll.dispatchEvent(new win.Event('wheel'));scroll.scrollTop=300;advance(400);
 assert.equal(scroll.scrollTop,300);assert.equal(controller.bottomMotion,null);assert.equal(controller.followsChat(),false);
 controller.scrollToBottom();advance(80);controller.cancel();scroll.scrollTop=50;advance(400);
 assert.equal(scroll.scrollTop,50);assert.equal(controller.bottomMotion,null);
});

test('scroll to bottom during keyboard opening reaches its final reading window without closing the keyboard',t=>{
 const {controller,scroll,advance,open,close,doc,$}=fixture(t,{glass:true});scroll.scrollTop=250;open();advance(80);
 controller.scrollToBottom();advance(160);advance(160);
 assert.equal(doc.activeElement,$('prompt'));assert.equal(controller.lift,363);
 assert.equal(scroll.scrollTop,1245);assert.equal(controller.atVisibleBottom(),true);assert.equal(controller.followsChat(),true);
 close();advance(240);assert.equal(scroll.scrollTop,882);assert.equal(controller.atVisibleBottom(),true);
});

test('reduced motion reaches bottom immediately; drafts and logged-out pages cannot scroll',t=>{
 const {controller,scroll,$}=fixture(t,{reduced:true});scroll.scrollTop=250;
 controller.scrollToBottom();assert.equal(scroll.scrollTop,882);assert.equal(controller.bottomMotion,null);
 scroll.scrollTop=250;$('workspace').classList.add('draftView');controller.scrollToBottom();assert.equal(scroll.scrollTop,250);
 $('workspace').classList.remove('draftView');$('workspace').hidden=true;controller.scrollToBottom();assert.equal(scroll.scrollTop,250);
});

test('reading older messages: only the composer moves; header, page height and reading position remain stable',t=>{
  const {$,controller,content,scroll,advance,open,close}=fixture(t);scroll.scrollTop=250;open();
  advance(120);assert.equal($('workspace').style.height,'844px');assert.equal($('chatScroll').style.height,'618px');
  assert.equal(content.style.transform,'');assert.equal(scroll.scrollTop,250);
  assert(controller.lift>0&&controller.lift<363);assert.equal(controller.followsChat(),false);
  advance(120);assert.equal(controller.lift,363);assert.equal(scroll.clientHeight,255);assert.equal(scroll.scrollTop,250);
  assert.equal($('chatViewport').style.marginBottom,'525px');assert.equal($('composerDock').style.transform,'translateY(-363px)');
  close();advance(240);assert.equal(scroll.clientHeight,618);assert.equal(scroll.scrollTop,250);assert.equal(content.style.transform,'');
});

test('true bottom follows the composer during motion, then reconciles real scrolling without a jump',t=>{
  const {controller,content,scroll,advance,open,close}=fixture(t);scroll.scrollTop=882;open();advance(120);
  const shift=parseFloat(content.style.transform.match(/-?[\d.]+/)[0]);assert.equal(shift,-controller.lift);
  const duringBottom=1500-scroll.scrollTop+shift;advance(120);
  assert.equal(content.style.transform,'');assert.equal(scroll.scrollTop,1245);assert.equal(scroll.clientHeight,255);
  assert.equal(1500-scroll.scrollTop,255);assert.equal(duringBottom,618-363*.875);
  close();advance(120);assert.equal(scroll.scrollTop,882);advance(120);
  assert.equal(scroll.clientHeight,618);assert.equal(scroll.scrollTop,882);assert.equal(controller.cycle,false);
});

test('a 50px gap is not treated as touching bottom, including idle polling during keyboard motion',t=>{
  const {controller,content,scroll,advance,open,close}=fixture(t);scroll.scrollTop=832;open();advance(240);
  assert.equal(scroll.scrollTop,832);assert.equal(content.style.transform,'');assert.equal(controller.followsChat(80),false);
  close();advance(240);assert.equal(controller.followsChat(80),false);assert.equal(scroll.scrollTop,832);
  scroll.scrollTop=882;scroll.dispatchEvent(new controller.win.Event('scroll'));assert.equal(controller.followsChat(),true);
});

test('short replies stay stationary until their end would be covered by the composer',t=>{
  const {controller,content,scroll,advance,open,close}=fixture(t,{natural:400});open();advance(120);
  assert.equal(content.style.transform,'translateY(-99.625px)');advance(120);
  assert.equal(scroll.scrollTop,145);assert.equal(scroll.clientHeight,255);close();advance(240);assert.equal(scroll.scrollTop,0);
  const empty=fixture(t,{natural:200});empty.open();empty.advance(240);assert.equal(empty.scroll.scrollTop,0);assert.equal(empty.content.style.transform,'');
});

test('native resize bursts do not repeatedly measure the transcript or restart an easing',t=>{
  const {controller,viewport,scroll,focus,advance,reads,$}=fixture(t);scroll.scrollTop=250;focus();const baseline=reads();
  for(let height=824;height>=444;height-=20){viewport.height=height;controller.viewport();advance(16);}
  assert.equal(reads()-baseline,0);assert.equal(scroll.scrollTop,250);assert.equal($('workspace').style.height,'844px');
  assert.equal(controller.lift,358);advance(150);assert.equal(scroll.clientHeight,260);assert.equal(scroll.scrollTop,250);
});

test('repeated cycles have the same endpoints and do not accumulate keyboard lift',t=>{
  const {controller,scroll,advance,open,close}=fixture(t);scroll.scrollTop=250;
  for(let i=0;i<5;i++){open();advance(240);assert.equal(controller.lift,363);close();advance(240);assert.equal(controller.lift,0);assert.equal(scroll.scrollTop,250);}
});

test('manual reading during animation cancels follow and preserves the new position',t=>{
  const {controller,scroll,advance,open}=fixture(t);scroll.scrollTop=882;open();advance(120);
  scroll.dispatchEvent(new controller.win.Event('wheel'));scroll.scrollTop=320;advance(120);
  assert.equal(scroll.scrollTop,320);assert.equal(controller.followsChat(),false);
});

test('document pan uses pageTop once without changing the resting height or measuring history',t=>{
  const {controller,viewport,reads,$}=fixture(t);const baseline=reads();
  for(let top=0;top<=80;top+=10){viewport.pageTop=top;controller.viewport();}
  assert.equal(reads(),baseline);assert.equal($('workspace').style.top,'80px');assert.equal($('workspace').style.height,'844px');
});

test('focus after a viewport shrink still recognizes the keyboard without shrinking the whole page',t=>{
  const {controller,viewport,$,focus,advance}=fixture(t);viewport.height=400;controller.viewport();
  assert.equal($('workspace').classList.contains('keyboardOpen'),false);focus();advance(240);
  assert.equal($('workspace').style.height,'844px');assert.equal(controller.lift,402);assert.equal($('workspace').classList.contains('keyboardOpen'),true);
});

test('drafts never follow transcript content and reduced motion applies the same final geometry',t=>{
  const {controller,$,content,scroll,open}=fixture(t,{reduced:true});$('workspace').classList.add('draftView');scroll.scrollTop=882;open();
  assert.equal(controller.motion,null);assert.equal(content.style.transform,'');assert.equal(scroll.scrollTop,882);assert.equal(controller.lift,363);
});

test('conversation switch cancels a pending restore, including mid-animation',t=>{
  const {controller,scroll,advance,open,viewport}=fixture(t);scroll.scrollTop=250;open();advance(120);
  controller.cancel();scroll.scrollTop=0;controller.viewport();advance(400);
  assert.equal(scroll.scrollTop,0);assert.equal(controller.lift,363);viewport.height=844;controller.viewport();advance(300);assert.equal(scroll.scrollTop,0);
});

test('rotation during an open keyboard uses the new resting screen size and keeps the reading position',t=>{
  const {controller,win,$,scroll,advance,open,viewport}=fixture(t);scroll.scrollTop=250;open();advance(240);
  Object.defineProperty(win,'innerWidth',{value:844,configurable:true});Object.defineProperty(win,'innerHeight',{value:390,configurable:true});
  Object.defineProperty($('composerDock'),'offsetHeight',{value:114,configurable:true});$('composerDock').style.paddingBottom='6px';
  Object.defineProperty($('chatViewport'),'offsetTop',{value:44,configurable:true});viewport.height=203;controller.viewport();advance(300);
  assert.equal($('workspace').style.height,'390px');assert.equal(controller.lift,187);assert.equal(scroll.clientHeight,45);assert.equal(scroll.scrollTop,250);
});

test('a short streaming reply can grow during keyboard motion without leaving its new end behind the input',t=>{
  const {controller,scroll,content,setNatural,advance,open}=fixture(t,{natural:400});open();advance(120);
  setNatural(700);controller.contentChanged();
  const shift=parseFloat(content.style.transform.match(/-?[\d.]+/)[0]);
  assert.equal(700-scroll.scrollTop+shift,618-controller.lift);advance(120);
  assert.equal(scroll.scrollTop,445);assert.equal(content.style.transform,'');assert.equal(scroll.clientHeight,255);
});

test('a browser safe-area change during an open keyboard recalibrates the same 6px docking gap',t=>{
  const {controller,$,scroll,advance,open}=fixture(t,{reduced:true});scroll.scrollTop=250;open();
  $('composerDock').style.paddingBottom='14px';Object.defineProperty($('composerDock'),'offsetHeight',{value:128,configurable:true});
  controller.geometry();advance(16);assert.equal(controller.lift,397);assert.equal(scroll.clientHeight,255);assert.equal(scroll.scrollTop,250);
});
