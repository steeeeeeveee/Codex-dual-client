import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
test('real phone mode controls, async question cards and adopt/refine use confirmed native state',async t=>{
 const dom=new JSDOM(await readFile(new URL('../static/index.html',import.meta.url),'utf8'),{url:'http://127.0.0.1:8769/'}),win=dom.window,doc=win.document;
 const old=new Map(),intervals=[];const set=(n,v)=>{old.set(n,Object.getOwnPropertyDescriptor(globalThis,n));Object.defineProperty(globalThis,n,{value:v,configurable:true,writable:true});};
 t.after(()=>{dom.window.close();for(const [n,v] of old){if(v)Object.defineProperty(globalThis,n,v);else delete globalThis[n];}});
 for(const n of ['window','document','sessionStorage','localStorage','Option','FormData'])set(n,n==='window'?win:win[n]);
 win.HTMLElement.prototype.scrollIntoView=function(){};
 set('setInterval',cb=>{intervals.push(cb);return intervals.length;});set('requestAnimationFrame',()=>1);set('cancelAnimationFrame',()=>{});set('EventSource',class{addEventListener(){}close(){}});
 const tid='phone-plan',state={mode:'shared',serviceMode:'shared',threadId:tid,desktop:{connected:true},planMode:true,turnId:'active',thread:{id:tid,turns:[{id:'active',status:'inProgress',items:[]}]},settings:{version:'e:1',next:{model:'m',effort:'high',mode:'default'},current:{model:'m',effort:'high',mode:'default'}},queue:[],outbox:[],pending:[]};
 const posts=[];
 set('fetch',async(url,opts)=>{let data;
  if(opts.method==='POST'){
   const p=JSON.parse(opts.body);posts.push([url,p]);
   if(url==='/api/thread/settings'){state.settings={version:'e:2',next:{model:'m',effort:'high',mode:p.mode},current:state.settings.current};data={status:'applied',settings:state.settings};}
   else if(url==='/api/answer'){state.pending=[];data={ok:true};}
   else if(url==='/api/plan/implement'){state.planReview=null;state.settings={version:'e:3',next:{model:'m',effort:'high',mode:'default'},current:null};data={status:'applied',settings:state.settings};}
   else throw Error('Unexpected POST '+url);
  }else if(url.startsWith('/api/state'))data=state;
  else if(url==='/api/threads')data={data:[{id:tid,name:'Plan test'}]};
  else if(url==='/api/capabilities')data={desktop:{connected:true},settings:true,planMode:true,projects:[],models:[{id:'m',name:'Model',defaultEffort:'high',efforts:[{id:'high'}]}]};
  else if(url==='/api/threads/requests')data={data:[]};
  else if(url.startsWith('/api/thread/'))data={mode:'shared',thread:state.thread};
  else throw Error('Unexpected '+url);
  return {ok:true,status:200,json:async()=>data};
 });
 win.sessionStorage.setItem('selectedThread','phone-plan');
 await import('../static/app.js');
 const settle=async()=>{for(let i=0;i<30;i++)await new Promise(r=>setTimeout(r,2));};await settle();
 const mode=doc.getElementById('conversationMode'),apply=doc.getElementById('applySettings');assert.equal(mode.disabled,false);assert.equal(mode.value,'default');
 doc.getElementById('openDrawer').click();assert.equal(posts.length,0);doc.getElementById('drawerScrim').click();doc.getElementById('openMode').click();doc.querySelector('[data-mode=plan]').click();assert.equal(posts.length,0);assert.equal(doc.getElementById('planBadge').hidden,true);assert.equal(state.settings.next.mode,'default');assert.equal(apply.disabled,false);apply.click();await settle();assert.equal(state.settings.next.mode,'plan');assert.equal(doc.getElementById('planBadge').hidden,false);doc.getElementById('closeSettings').click();assert(doc.getElementById('settingsStatus').textContent.includes('本轮：执行模式'));assert(doc.getElementById('settingsStatus').textContent.includes('后续：计划模式'));
 state.pending=[{clientRequestId:'native-token',method:'mobile/asyncQuestion',params:{threadId:tid,questions:[{id:'real-question',question:'选择部署位置？',isOther:true,options:[{label:'本机',description:''},{label:'云端',description:''}]}]}}];await intervals[0]();
 assert.equal(doc.querySelectorAll('#questions input[type=radio]').length,2);const free=doc.querySelector('#questions input[type=text]');free.value='测试环境';free.dispatchEvent(new win.Event('input'));doc.querySelector('#questions form').dispatchEvent(new win.Event('submit',{cancelable:true}));await settle();assert.deepEqual(posts.find(p=>p[0]==='/api/answer')[1].answers,{'real-question':'测试环境'});assert.equal(doc.querySelectorAll('#questions form').length,0);
 state.turnId=null;state.settings.current=null;state.thread.turns=[{id:'active',status:'completed',items:[{id:'p',type:'plan',text:'**最终方案**：先验证，再实施。'}]}];state.planReview={id:'native-plan',turnId:'active',text:'**最终方案**：先验证，再实施。'};await intervals[0]();
 assert.equal(doc.getElementById('planReview').hidden,false);assert.equal(doc.getElementById('implementPlan').disabled,false);assert.equal(doc.querySelector('#history strong').textContent,'最终方案');doc.getElementById('refinePlan').click();assert.equal(posts.length,2);assert.equal(mode.value,'plan');
 doc.getElementById('implementPlan').click();doc.getElementById('implementPlan').click();await settle();assert.equal(posts.filter(p=>p[0]==='/api/plan/implement').length,1);assert.equal(mode.value,'default');assert.equal(doc.getElementById('planReview').hidden,true);
 await intervals[0]();assert.equal(doc.getElementById('planRecoveryHint').hidden,false);assert.equal(posts.filter(p=>p[0]==='/api/plan/implement').length,1);
 doc.getElementById('newThread').click();await settle();mode.value='plan';mode.dispatchEvent(new win.Event('change'));assert.equal(JSON.parse(win.localStorage.getItem('newConversationDraft')).mode,'plan');
});
