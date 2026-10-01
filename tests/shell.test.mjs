import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {MobileShell} from '../static/shell.mjs';

function transition(dom,element,property='transform'){
 const event=new dom.window.Event('transitionend',{bubbles:true});Object.defineProperty(event,'propertyName',{value:property});element.dispatchEvent(event);
}

function fixture(t){
 const dom=new JSDOM(readFileSync(new URL('../static/index.html',import.meta.url),'utf8'),{pretendToBeVisual:true});t.after(()=>dom.window.close());
 const doc=dom.window.document;doc.getElementById('workspace').hidden=false;
 Object.defineProperty(doc.getElementById('prompt'),'clientWidth',{value:320});
 const shell=new MobileShell(doc),$=id=>doc.getElementById(id);
 const state={newMode:false,selected:'a',current:{mode:'shared',threadId:'a',thread:{name:'原对话'},desktop:{connected:true},queue:[],outbox:[]},busy:false,settingsBase:{next:{model:'m',effort:'high',mode:'default'}},settingsDirty:false,capabilities:{models:[{id:'m',name:'模型 M'}]},serviceOnline:true,streamOnline:true,creationRows:[]};
 $('threads').append(new dom.window.Option('原对话','a'),new dom.window.Option('另一对话','b'));$('modelControls').hidden=false;$('model').append(new dom.window.Option('模型 M','m'));$('model').value='m';
 return {dom,doc,shell,$,state};
}
test('drawer and menus only change presentation; rapid reopen is operable and Escape restores focus',t=>{
 const {shell,$,state,dom}=fixture(t);let changes=0;$('threads').onchange=()=>changes++;
 shell.sync(state);$('openDrawer').click();assert.equal($('drawer').hidden,false);assert.equal($('chatShell').inert,true);assert.equal(changes,0);
 $('drawerScrim').click();$('openDrawer').click();assert.equal($('drawer').inert,false);
 $('threadList').querySelector('[data-thread-id=b]').click();assert.equal(changes,0);assert.equal(shell.drawerOpen,false);
 transition(dom,$('chatShell'));assert.equal(changes,1);assert.equal($('threads').value,'b');
 $('openModel').click();assert.equal(shell.panelView,'models');assert.equal($('compose').inert,true);
 dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));assert.equal($('settingsPanel').hidden,true);assert.equal($('compose').inert,false);assert.equal(dom.window.document.activeElement,$('openModel'));
});

function swipe(dom,target,from,to,extra={}){
 for(const [type,point] of [['touchstart',from],['touchmove',to],['touchend',to]]){
   const event=new dom.window.Event(type,{bubbles:true,cancelable:true});
   const touch={identifier:1,clientX:point[0],clientY:point[1]};
   Object.defineProperties(event,{touches:{value:type==='touchend'?[]:[touch]},changedTouches:{value:[touch]}});
   target.dispatchEvent(event);
 }
}
function timedTouch(dom) {
 let now=0;Object.defineProperty(dom.window.performance,'now',{value:()=>now});
 return (target,type,x,y,time,extra={})=>{
  now=time;const event=new dom.window.Event(type,{bubbles:true,cancelable:true});
  const point={identifier:1,clientX:x,clientY:y};
  Object.defineProperties(event,{touches:{value:type==='touchend'||type==='touchcancel'?[]:[point]},changedTouches:{value:[point]},...extra});
  target.dispatchEvent(event);return event;
 };
}
const frame=()=>new Promise(resolve=>setTimeout(resolve,24));

test('history and chat follow each move before release; polling preserves the position and reading scroll',async t=>{
 const {shell,$,dom,state}=fixture(t),touch=timedTouch(dom);shell.sync(state);
 $('chatScroll').scrollTop=250;
 touch($('history'),'touchstart',70,180,0);
 const move=touch($('history'),'touchmove',82,182,30);await frame();
 assert.equal(move.defaultPrevented,true);assert.equal($('workspace').classList.contains('drawerDragging'),true);
 assert.equal($('workspace').style.getPropertyValue('--drawer-drag-x'),'12px');assert.equal(shell.drawerOpen,false);
 touch($('history'),'touchmove',128,184,60);touch($('history'),'touchmove',170,184,80);await frame();
 assert.equal($('workspace').style.getPropertyValue('--drawer-drag-x'),'100px');
 for(let i=0;i<5;i++)shell.sync(state);
 assert.equal($('workspace').style.getPropertyValue('--drawer-drag-x'),'100px');assert.equal($('chatScroll').scrollTop,250);
 touch($('history'),'touchend',170,184,85);assert.equal(shell.drawerOpen,true);
 assert.equal($('workspace').classList.contains('drawerDragging'),false);assert.equal($('chatScroll').scrollTop,250);
});

test('a short 24 pixel flick opens and closes history without selecting the row under the finger',t=>{
 const {shell,$,dom,state}=fixture(t),touch=timedTouch(dom);let changes=0;$('threads').onchange=()=>changes++;shell.sync(state);
 touch($('history'),'touchstart',70,180,0);touch($('history'),'touchmove',94,182,45);touch($('history'),'touchend',94,182,50);
 assert.equal(shell.drawerOpen,true);assert.equal($('chatShell').inert,true);
 const row=$('threadList').querySelector('[data-thread-id=b]');
 touch(row,'touchstart',210,180,500);touch(row,'touchmove',186,181,545);touch(row,'touchend',186,181,550);
 assert.equal(shell.drawerClosing,true);row.click();assert.equal(changes,0);
 transition(dom,$('chatShell'));assert.equal($('drawer').hidden,true);assert.equal($('chatShell').inert,false);
});

test('a slow partial drag or a held flick returns, while passing the distance threshold opens',t=>{
 const {shell,$,dom}=fixture(t),touch=timedTouch(dom);
 touch($('history'),'touchstart',70,180,0);touch($('history'),'touchmove',110,181,200);touch($('history'),'touchend',110,181,400);
 assert.equal(shell.drawerOpen,false);assert.equal(shell.drawerClosing,true);assert.equal($('drawer').hidden,false);
 transition(dom,$('chatShell'));assert.equal($('drawer').hidden,true);
 touch($('history'),'touchstart',70,180,500);touch($('history'),'touchmove',270,182,1000);touch($('history'),'touchend',270,182,1200);
 assert.equal(shell.drawerOpen,true);
 const row=$('threadList');touch(row,'touchstart',270,180,1300);touch(row,'touchmove',230,181,1500);touch(row,'touchend',230,181,1700);
 assert.equal(shell.drawerOpen,true);assert.equal(shell.drawerClosing,false);
});

test('ordinary release uses a symmetric distance threshold on small and large screens',t=>{
 for(const width of [320,390,430,740]){
  const {shell,$,dom}=fixture(t),touch=timedTouch(dom);Object.defineProperty(dom.window,'innerWidth',{value:width});
  const drawerWidth=Math.min(width*.82,340),threshold=drawerWidth/3;
  touch($('history'),'touchstart',60,180,0);touch($('history'),'touchmove',60+threshold-1,181,300);touch($('history'),'touchend',60+threshold-1,181,500);
  assert.equal(shell.drawerOpen,false);assert.equal(shell.drawerClosing,true);transition(dom,$('chatShell'));
  touch($('history'),'touchstart',60,180,600);touch($('history'),'touchmove',60+threshold+1,181,900);touch($('history'),'touchend',60+threshold+1,181,1100);
  assert.equal(shell.drawerOpen,true);
  touch($('threadList'),'touchstart',220,180,1200);touch($('threadList'),'touchmove',220-threshold+1,181,1500);touch($('threadList'),'touchend',220-threshold+1,181,1700);
  assert.equal(shell.drawerOpen,true);assert.equal(shell.drawerClosing,false);
  touch($('threadList'),'touchstart',220,180,1800);touch($('threadList'),'touchmove',220-threshold-1,181,2100);touch($('threadList'),'touchend',220-threshold-1,181,2300);
  assert.equal(shell.drawerOpen,false);assert.equal(shell.drawerClosing,true);transition(dom,$('chatShell'));
  assert.equal($('drawerScrim').hidden,true);assert.equal($('chatShell').inert,false);
 }
});

test('a held short swipe returns slowly, but a fresh short flick retains its direction-based switch',t=>{
 const {shell,$,dom}=fixture(t),touch=timedTouch(dom);
 touch($('history'),'touchstart',70,180,0);touch($('history'),'touchmove',94,181,45);touch($('history'),'touchend',94,181,250);
 assert.equal(shell.drawerOpen,false);assert.equal(shell.drawerClosing,true);
 const returnDuration=parseFloat($('workspace').style.getPropertyValue('--drawer-settle-duration'));
 assert.ok(returnDuration>=360&&returnDuration<=520);transition(dom,$('chatShell'));
 touch($('history'),'touchstart',70,180,400);touch($('history'),'touchmove',94,181,445);touch($('history'),'touchend',94,181,450);
 assert.equal(shell.drawerOpen,true);
 const finishDuration=parseFloat($('workspace').style.getPropertyValue('--drawer-settle-duration'));
 assert.ok(finishDuration>returnDuration);assert.ok(finishDuration<=520);
});

test('the whole chat card and its tap surface scale together; shadow sits above history and clears on return',async t=>{
 const {shell,$,dom}=fixture(t),touch=timedTouch(dom);
 const style=dom.window.document.createElement('style');style.textContent=readFileSync(new URL('../static/style.css',import.meta.url),'utf8');dom.window.document.head.append(style);
 shell.fitPrompt();
 Object.defineProperty($('chatScroll'),'clientHeight',{value:500});Object.defineProperty($('chatScroll'),'scrollHeight',{value:1500});
 $('chatScroll').scrollTop=250;$('prompt').value='保留这条草稿';
 const height=$('workspace').style.height,chatHeight=$('chatScroll').style.height;
 touch($('history'),'touchstart',70,180,0);touch($('history'),'touchmove',240,181,300);await frame();
 assert.equal($('workspace').style.getPropertyValue('--drawer-drag-progress'),'0.5');
 const chatStyle=dom.window.getComputedStyle($('chatShell')),scrimStyle=dom.window.getComputedStyle($('drawerScrim'));
 assert.equal(chatStyle.transform,scrimStyle.transform);assert.match(chatStyle.transform,/scale\(calc\(/);
 assert.equal(chatStyle.transformOrigin,'left center');assert.equal(scrimStyle.transformOrigin,'left center');
 assert.equal(chatStyle.borderRadius,scrimStyle.borderRadius);assert.match(chatStyle.boxShadow,/48px/);
 assert.ok(Number(chatStyle.zIndex)>Number(dom.window.getComputedStyle($('drawer')).zIndex));
 assert.equal($('workspace').style.height,height);assert.equal($('chatScroll').style.height,chatHeight);assert.equal($('chatScroll').scrollTop,250);assert.equal($('prompt').value,'保留这条草稿');
 touch($('history'),'touchend',240,181,500);assert.equal(shell.drawerOpen,true);shell.closeDrawer();transition(dom,$('chatShell'));
 assert.equal($('workspace').classList.contains('drawerVisible'),false);assert.equal($('workspace').style.getPropertyValue('--drawer-drag-progress'),'');
 assert.equal(dom.window.getComputedStyle($('chatShell')).transform,'translateX(0)');
 assert.equal(dom.window.getComputedStyle($('chatShell')).boxShadow,'0 12px 48px rgba(0,0,0,0),0 0 0 1px rgba(0,0,0,0)');
});

test('catching a scaled closing card resumes the same position without clearing its content',async t=>{
 const {shell,$,dom}=fixture(t),touch=timedTouch(dom);$('history').textContent='完整保留聊天内容';shell.openDrawer();shell.closeDrawer(false);
 const compute=dom.window.getComputedStyle.bind(dom.window);
 dom.window.getComputedStyle=element=>element===$('chatShell')?{transform:'matrix(0.975, 0, 0, 0.975, 170, 0)'}:compute(element);
 touch($('drawerScrim'),'touchstart',220,180,0);touch($('drawerScrim'),'touchmove',240,181,60);await frame();
 assert.equal($('workspace').style.getPropertyValue('--drawer-drag-x'),'190px');
 assert.equal(Number($('workspace').style.getPropertyValue('--drawer-drag-progress')),190/340);
 assert.equal(shell.drawerClosing,false);assert.equal($('history').textContent,'完整保留聊天内容');
 touch($('drawerScrim'),'touchend',240,181,250);assert.equal(shell.drawerOpen,true);
});

test('reversing a drag follows the finger backwards and settles in its latest direction',async t=>{
 const {shell,$,dom}=fixture(t),touch=timedTouch(dom);
 touch($('history'),'touchstart',70,180,0);touch($('history'),'touchmove',320,181,200);await frame();
 assert.equal($('workspace').style.getPropertyValue('--drawer-drag-x'),'250px');
 touch($('history'),'touchmove',290,181,250);await frame();
 assert.equal($('workspace').style.getPropertyValue('--drawer-drag-x'),'220px');
 touch($('history'),'touchend',260,181,280);assert.equal(shell.drawerOpen,false);assert.equal(shell.drawerClosing,true);
 transition(dom,$('chatShell'));assert.equal($('workspace').classList.contains('drawerVisible'),false);
});

test('touch cancellation and a second finger restore the initial state without leaving a blocking scrim',t=>{
 const {shell,$,dom}=fixture(t),touch=timedTouch(dom);
 touch($('history'),'touchstart',70,180,0);touch($('history'),'touchmove',140,181,50);touch($('history'),'touchcancel',140,181,60);
 assert.equal(shell.drawerGesture,null);assert.equal($('workspace').classList.contains('drawerDragging'),false);
 transition(dom,$('chatShell'));assert.equal($('drawerScrim').hidden,true);assert.equal($('chatShell').inert,false);
 shell.openDrawer();touch($('threadList'),'touchstart',220,180,500);touch($('threadList'),'touchmove',120,181,560);
 touch($('threadList'),'touchstart',120,181,570,{touches:{value:[{identifier:1,clientX:120,clientY:181},{identifier:2,clientX:160,clientY:181}]}});
 assert.equal(shell.drawerOpen,true);assert.equal(shell.drawerClosing,false);assert.equal(shell.drawerGesture,null);assert.equal($('drawer').inert,false);
});

test('catching a closing drawer starts at its rendered position and cancels a pending history selection',async t=>{
 const {shell,$,dom,state}=fixture(t),touch=timedTouch(dom);let changes=0;$('threads').onchange=()=>changes++;shell.sync(state);
 shell.openDrawer();$('threadList').querySelector('[data-thread-id=b]').click();assert.equal(shell.drawerClosing,true);
 const compute=dom.window.getComputedStyle.bind(dom.window);
 dom.window.getComputedStyle=element=>element===$('chatShell')?{transform:'matrix(1, 0, 0, 1, 80, 0)'}:compute(element);
 touch($('drawerScrim'),'touchstart',100,180,0);touch($('drawerScrim'),'touchmove',150,181,50);await frame();
 assert.equal($('workspace').style.getPropertyValue('--drawer-drag-x'),'130px');assert.equal(shell.drawerClosing,false);
 touch($('drawerScrim'),'touchend',150,181,55);assert.equal(shell.drawerOpen,true);
 transition(dom,$('chatShell'));await new Promise(resolve=>setTimeout(resolve,390));
 assert.equal(changes,0);assert.equal($('drawer').hidden,false);
});

test('dragging is bounded at the drawer width on narrow and wide screens; taps keep their normal action',async t=>{
 for(const width of [320,390,430,740]){
  const {shell,$,dom}=fixture(t),touch=timedTouch(dom);Object.defineProperty(dom.window,'innerWidth',{value:width});
  touch($('history'),'touchstart',60,180,0);touch($('history'),'touchmove',1000,181,50);await frame();
  assert.equal(parseFloat($('workspace').style.getPropertyValue('--drawer-drag-x')),Math.min(width*.82,340));
  touch($('history'),'touchend',1000,181,55);assert.equal(shell.drawerOpen,true);
 }
 const {shell,$,dom}=fixture(t),touch=timedTouch(dom);let clicks=0;$('history').onclick=()=>clicks++;
 touch($('history'),'touchstart',70,180,0);touch($('history'),'touchmove',73,181,30);touch($('history'),'touchend',73,181,40);$('history').click();
 assert.equal(clicks,1);assert.equal($('drawer').hidden,true);assert.equal(shell.drawerClosing,false);
});

test('gesture settling never forces an intermediate closed layout before opening',t=>{
 const {shell,$,dom}=fixture(t),touch=timedTouch(dom);let closedReads=0;
 Object.defineProperty($('drawer'),'offsetWidth',{get(){if(!$('workspace').classList.contains('drawerDragging'))closedReads++;return 320;}});
 touch($('history'),'touchstart',70,180,0);const before=closedReads;
 touch($('history'),'touchmove',110,181,50);touch($('history'),'touchend',110,181,55);
 assert.equal(shell.drawerOpen,true);assert.equal(closedReads,before);
});

test('sparse touch events still recognize a flick, and reduced motion only skips the release animation',t=>{
 const {shell,$,dom}=fixture(t),touch=timedTouch(dom);
 dom.window.matchMedia=()=>({matches:true});
 touch($('history'),'touchstart',70,180,0);touch($('history'),'touchmove',170,181,120);
 assert.equal($('workspace').classList.contains('drawerDragging'),true);assert.equal(shell.drawerOpen,false);
 touch($('history'),'touchend',170,181,125);assert.equal(shell.drawerOpen,true);
 touch($('threadList'),'touchstart',220,180,400);touch($('threadList'),'touchmove',120,181,520);touch($('threadList'),'touchend',120,181,525);
 assert.equal(shell.drawerClosing,false);assert.equal($('drawerScrim').hidden,true);assert.equal($('chatShell').inert,false);
});

test('a vertical scroll never becomes a drawer drag later, and switching views clears an active drag',t=>{
 const {shell,$,dom}=fixture(t),touch=timedTouch(dom);
 touch($('history'),'touchstart',70,180,0);touch($('history'),'touchmove',74,198,30);
 const move=touch($('history'),'touchmove',170,198,70);touch($('history'),'touchend',170,198,80);
 assert.equal(move.defaultPrevented,false);assert.equal($('drawer').hidden,true);
 touch($('history'),'touchstart',70,180,400);touch($('history'),'touchmove',170,181,450);
 $('workspace').hidden=true;shell.closeAll();
 assert.equal(shell.drawerGesture,null);assert.equal(shell.drawerFrame,null);assert.equal($('drawer').hidden,true);
 assert.equal($('drawerScrim').hidden,true);assert.equal($('workspace').classList.contains('drawerDragging'),false);
});

test('a fresh tap immediately after a flick can select history, and returning exactly to zero leaves no lock',t=>{
 const {shell,$,dom,state}=fixture(t),touch=timedTouch(dom);let changes=0;$('threads').onchange=()=>changes++;shell.sync(state);
 touch($('history'),'touchstart',70,180,0);touch($('history'),'touchmove',94,181,45);touch($('history'),'touchend',94,181,50);
 const row=$('threadList').querySelector('[data-thread-id=b]');row.click();assert.equal(changes,0);
 touch(row,'touchstart',100,180,100);touch(row,'touchend',100,180,110);row.click();transition(dom,$('chatShell'));assert.equal(changes,1);
 touch($('history'),'touchstart',70,180,500);touch($('history'),'touchmove',110,181,560);touch($('history'),'touchend',70,181,600);
 assert.equal(shell.drawerClosing,false);assert.equal($('drawer').hidden,true);assert.equal($('drawerScrim').hidden,true);assert.equal($('chatShell').inert,false);
});

test('standalone phone app accepts an edge flick while media gestures remain untouched',t=>{
 const {shell,$,dom}=fixture(t),touch=timedTouch(dom);Object.defineProperty(dom.window.navigator,'standalone',{value:true});
 for(const name of ['chatImage','chatVideo']){
  const media=dom.window.document.createElement('figure');media.className='chatImage '+name;
  const video=dom.window.document.createElement('video');media.append(video);$('history').append(media);
  touch(video,'touchstart',70,180,0);const move=touch(video,'touchmove',94,181,45);touch(video,'touchend',94,181,50);
  assert.equal(move.defaultPrevented,false);assert.equal(shell.drawerOpen,false);
 }
 touch($('history'),'touchstart',3,180,200);touch($('history'),'touchmove',27,181,245);touch($('history'),'touchend',27,181,250);
 assert.equal(shell.drawerOpen,true);
});
test('right swipe opens history, left swipe closes it, and the release cannot select a history row',t=>{
 const {shell,$,state,dom}=fixture(t);let changes=0;$('threads').onchange=()=>changes++;shell.sync(state);
 swipe(dom,$('history'),[70,180],[180,186]);assert.equal(shell.drawerOpen,true);assert.equal(changes,0);
 const row=$('threadList').querySelector('[data-thread-id=b]');swipe(dom,row,[210,180],[110,184]);assert.equal(shell.drawerClosing,true);
 row.click();transition(dom,$('chatShell'));assert.equal(changes,0);assert.equal($('drawer').hidden,true);
});
test('vertical reading, composer controls, horizontal tables and screen edges never toggle history',t=>{
 const {shell,$,state,dom}=fixture(t);shell.sync(state);
 swipe(dom,$('history'),[70,180],[85,300]);assert.equal(shell.drawerOpen,false);
 swipe(dom,$('prompt'),[70,180],[180,186]);assert.equal(shell.drawerOpen,false);
 swipe(dom,$('history'),[5,180],[180,186]);assert.equal(shell.drawerOpen,false);
 const table=dom.window.document.createElement('div');table.className='table-scroll';$('history').append(table);
 swipe(dom,table,[70,180],[180,186]);assert.equal(shell.drawerOpen,false);
});
test('confirmed mode differs from uncommitted selection; new draft shows its own settings',t=>{
 const {shell,$,state}=fixture(t);$('conversationMode').value='plan';state.settingsDirty=true;shell.sync(state);
 assert.equal($('planBadge').hidden,true);assert.equal($('dirtyDot').hidden,false);assert.equal($('chatTitle').textContent,'原对话');
 state.settingsBase.next.mode='plan';state.settingsDirty=false;shell.sync(state);assert.equal($('planBadge').hidden,false);
 state.newMode=true;state.selected='';shell.sync(state);assert.equal($('welcome').hidden,false);assert.equal($('transcript').hidden,true);assert.equal($('chatTitle').textContent,'');assert.equal($('dirtyDot').hidden,true);
});
test('queue totals, uncertainty and offline remain visible when details are collapsed',t=>{
 const {shell,$,state}=fixture(t);shell.sync(state);assert.equal($('queueCard').hidden,true);
 state.current.queue=[{id:'one',text:'正式队列'}];state.current.outbox=[{id:'one',status:'queued'},{id:'two',status:'needs-review'}];shell.sync(state);
 assert.equal($('queueCount').textContent,'2 条');assert.equal($('queueDetails').open,false);assert.equal($('queueAlert').hidden,false);assert.match($('queueAlert').textContent,/结果待核对/);
 state.current.desktop.connected=false;shell.sync(state);assert.equal($('connectionAlert').hidden,false);assert.match($('connectionAlert').textContent,/等待电脑/);
});


test('polling while typing does not collapse the composer, move the chat or close the active menu',t=>{
 const {shell,$,state,dom}=fixture(t);shell.sync(state);
 $('prompt').value='正在输入的草稿';Object.defineProperty(shell.promptMeasure,'scrollHeight',{value:100,configurable:true});
 Object.defineProperty($('chatScroll'),'clientHeight',{value:500});Object.defineProperty($('chatScroll'),'scrollHeight',{value:1500});
 $('chatScroll').scrollTop=250;shell.fitPrompt();assert.equal($('chatScroll').scrollTop,250);assert.equal($('prompt').style.height,'100px');
 const changes=new dom.window.MutationObserver(()=>{});changes.observe($('prompt'),{attributes:true,attributeFilter:['style']});
 shell.openPanel('mode');for(let i=0;i<10;i++)shell.sync(state);
 assert.equal(changes.takeRecords().length,0);changes.disconnect();assert.equal($('chatScroll').scrollTop,250);assert.equal(shell.panelView,'mode');
 assert.equal($('settingsScrim').parentElement,$('composerDock').parentElement);
});

test('short visible keyboard space caps a long draft without remeasuring its text on viewport frames',t=>{
 const {shell,$,dom}=fixture(t);shell.fitPrompt();
 Object.defineProperty(shell.promptMeasure,'scrollHeight',{value:700,configurable:true});
 $('prompt').value='保留多行输入';shell.fitPrompt();assert.equal($('prompt').style.height,'169px');
 let reads=0;Object.defineProperty(shell.promptMeasure,'scrollHeight',{get(){reads++;return 700;}});
 const viewport=Object.assign(new dom.window.EventTarget(),{height:768,pageTop:0,scale:1});
 Object.defineProperty(dom.window,'visualViewport',{value:viewport});shell.viewport();$('prompt').focus();
 viewport.height=200;shell.viewport();assert.equal($('prompt').style.height,'55px');
 assert.equal($('prompt').value,'保留多行输入');assert.equal(reads,0);assert.equal($('workspace').style.height,'768px');
});

test('repeated viewport scroll notifications without a size change do not snap to the bottom',t=>{
 const {shell,$,dom}=fixture(t);Object.defineProperty(dom.window,'visualViewport',{value:{height:600,offsetTop:0}});shell.viewport();
 Object.defineProperty($('chatScroll'),'clientHeight',{value:500});Object.defineProperty($('chatScroll'),'scrollHeight',{value:1000});
 $('chatScroll').scrollTop=470;for(let i=0;i<8;i++)shell.viewport();assert.equal($('chatScroll').scrollTop,470);
});



test('viewport fallback includes page scroll, while a panned viewport alone does not show a keyboard',t=>{
 const {shell,$,dom}=fixture(t);Object.defineProperty(dom.window,'scrollY',{value:25});
 Object.defineProperty(dom.window,'visualViewport',{value:{height:700,offsetTop:40}});shell.viewport();
 assert.equal($('workspace').style.top,'65px');
 assert.equal($('workspace').classList.contains('keyboardOpen'),false);
});

test('closing history retains the moving scrim and input lock through the slide, then releases them once',t=>{
 const {shell,$,dom}=fixture(t);shell.openDrawer();shell.closeDrawer();
 assert.equal($('drawerScrim').hidden,false);assert.equal($('chatShell').inert,true);assert.equal($('workspace').classList.contains('drawerVisible'),true);
 transition(dom,$('drawer'));transition(dom,$('chatShell'),'opacity');assert.equal(shell.drawerClosing,true);
 transition(dom,$('chatShell'));assert.equal(shell.drawerClosing,false);assert.equal($('drawerScrim').hidden,true);assert.equal($('chatShell').inert,false);
 assert.equal($('drawer').hidden,true);assert.equal(dom.window.document.activeElement,$('openDrawer'));
});

test('reopening cancels a pending history switch; reduced motion switches without waiting',async t=>{
 const {shell,$,dom,state}=fixture(t);let changes=0;$('threads').onchange=()=>changes++;shell.sync(state);shell.openDrawer();
 $('threadList').querySelector('[data-thread-id=b]').click();shell.openDrawer();await new Promise(resolve=>setTimeout(resolve,310));
 assert.equal(changes,0);assert.equal($('drawer').hidden,false);assert.equal($('drawer').inert,false);
 dom.window.matchMedia=()=>({matches:true});$('threadList').querySelector('[data-thread-id=b]').click();
 assert.equal(changes,1);assert.equal($('threads').value,'b');assert.equal($('drawerScrim').hidden,true);
});

test('returning to the already selected history item does not clear or reload its transcript',t=>{
 const {shell,$,dom,state}=fixture(t);let changes=0;$('threads').value='a';$('threads').onchange=()=>changes++;
 $('history').textContent='当前聊天内容';shell.sync(state);shell.openDrawer();$('threadList').querySelector('[data-thread-id=a]').click();
 transition(dom,$('chatShell'));assert.equal(changes,0);assert.equal($('history').textContent,'当前聊天内容');assert.equal($('drawer').hidden,true);
});



test('viewport panning only changes position and never measures text or scroll geometry',async t=>{
 const {shell,$,dom}=fixture(t);shell.fitPrompt();await new Promise(resolve=>setTimeout(resolve,180));
 const viewport={height:600,pageTop:0,offsetTop:0};Object.defineProperty(dom.window,'visualViewport',{value:viewport});shell.viewport();await new Promise(resolve=>setTimeout(resolve,180));
 let reads=0;Object.defineProperty(shell.promptMeasure,'scrollHeight',{get(){reads++;return 100;}});
 Object.defineProperty($('chatScroll'),'scrollHeight',{get(){reads++;return 1500;}});
 for(let top=0;top<=80;top+=10){viewport.pageTop=top;shell.viewport();}
 assert.equal(reads,0);assert.equal($('workspace').style.top,'80px');
});
