// Isolated browser acceptance. Use the real shell's public touch listeners;
// never edit its styles or call a business API. /drawer is test-server only.
const query=new URLSearchParams(location.search),scenario=query.get('gesture')||'half';
const root=document.documentElement,workspace=document.getElementById('workspace');
function touch(type,x,y=270){
  const target=document.getElementById('history'),point=new Touch({identifier:1,target,clientX:x,clientY:y,pageX:x,pageY:y,screenX:x,screenY:y});
  target.dispatchEvent(new TouchEvent(type,{bubbles:true,cancelable:true,touches:type==='touchend'?[]:[point],changedTouches:[point]}));
}
async function run(){
  if(workspace.hidden||!document.getElementById('history').children.length){requestAnimationFrame(run);return;}
  const width=Math.min(innerWidth*.82,340),start=70;
  const distance=scenario==='small'?width*.2:scenario==='large'?width*.45:scenario==='flick'?24:width*.5;
  const fromOpen=scenario==='close-small'||scenario==='close-large';
  if(fromOpen){document.getElementById('openDrawer').click();await new Promise(resolve=>setTimeout(resolve,560));}
  const target=fromOpen?document.getElementById('threadList'):document.getElementById('history');
  const emit=(type,x)=>{
    const point=new Touch({identifier:1,target,clientX:x,clientY:270,pageX:x,pageY:270,screenX:x,screenY:270});
    target.dispatchEvent(new TouchEvent(type,{bubbles:true,cancelable:true,touches:type==='touchend'?[]:[point],changedTouches:[point]}));
  };
  root.dataset.drawerScenario=scenario;emit('touchstart',fromOpen?250:start);
  if(scenario==='half'){
    touch('touchmove',start+distance);requestAnimationFrame(()=>{root.dataset.drawerStage='held';});return;
  }
  const span=fromOpen?(scenario==='close-small'?width*.2:width*.45):distance;
  const begin=performance.now(),duration=scenario==='flick'?45:300;
  await new Promise(resolve=>{
    const step=now=>{const progress=Math.min(1,(now-begin)/duration);emit('touchmove',fromOpen?250-span*progress:start+span*progress);if(progress<1)requestAnimationFrame(step);else resolve();};
    requestAnimationFrame(step);
  });
  if(scenario!=='flick')await new Promise(resolve=>setTimeout(resolve,160));
  emit('touchend',fromOpen?250-span:start+span);root.dataset.drawerStage='settling';
  setTimeout(()=>{root.dataset.drawerStage='settled';},600);
}
requestAnimationFrame(run);
