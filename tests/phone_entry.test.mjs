import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';

test('login enters a draft; menus never submit; first send preserves native creation settings and retry IDs',async t=>{
 const dom=new JSDOM(readFileSync(new URL('../static/index.html',import.meta.url),'utf8'),{url:'http://127.0.0.1:8772/'}),win=dom.window,doc=win.document,old=new Map(),intervals=[];
 const set=(name,value)=>{old.set(name,Object.getOwnPropertyDescriptor(globalThis,name));Object.defineProperty(globalThis,name,{value,writable:true,configurable:true});};
 t.after(()=>{win.close();for(const [name,value] of old){if(value)Object.defineProperty(globalThis,name,value);else delete globalThis[name];}});
 for(const name of ['window','document','sessionStorage','localStorage','Option','FormData'])set(name,name==='window'?win:win[name]);
 win.HTMLElement.prototype.scrollIntoView=function(){};set('setInterval',fn=>{intervals.push(fn);return intervals.length;});set('EventSource',class{addEventListener(){}close(){}});
 let loggedIn=false;const posts=[];let creation=null;
 set('fetch',async(url,options)=>{
  if(!loggedIn&&url!=='/api/login')return {ok:false,status:401,json:async()=>({detail:'请先登录'})};
  let data;
  if(options.method==='POST'){
   const body=JSON.parse(options.body);posts.push([url,body]);
   if(url==='/api/login'){loggedIn=true;data={ok:true};}
   else if(url==='/api/threads'){creation=body;data={status:'waiting'};}
   else throw Error('Unexpected mutation '+url);
  }else if(url.startsWith('/api/state'))data={serviceMode:'shared',threadId:'old',pending:[]};
  else if(url==='/api/threads')data={data:[{id:'old',name:'已有对话'}]};
  else if(url==='/api/capabilities')data={desktop:{connected:true},create:true,settings:true,planMode:true,projects:[{id:'p',name:'已有项目'}],models:[{id:'m',name:'Model',defaultEffort:'low',efforts:[{id:'low'},{id:'high'}]}]};
  else if(url==='/api/threads/requests')data={data:creation?[{...creation,status:'waiting'}]:[]};
  else throw Error('Unexpected read '+url);
  return {ok:true,status:200,json:async()=>data};
 });
 const settle=async()=>{for(let i=0;i<30;i++)await new Promise(r=>setTimeout(r,2));};
 await import('../static/app.js');await settle();assert.equal(doc.getElementById('login').hidden,false);
 doc.getElementById('password').value='fixture-only';doc.getElementById('loginForm').dispatchEvent(new win.Event('submit',{cancelable:true}));await settle();
 assert.equal(doc.getElementById('welcome').hidden,false);assert.equal(posts.length,1);assert.equal(sessionStorage.getItem('selectedThread'),null);
 doc.getElementById('openMode').click();doc.querySelector('[data-mode=plan]').click();doc.getElementById('project').value='p';doc.getElementById('project').dispatchEvent(new win.Event('change'));doc.getElementById('closeSettings').click();doc.getElementById('openModel').click();
 doc.getElementById('model').value='m';doc.getElementById('model').dispatchEvent(new win.Event('change'));doc.getElementById('effort').value='high';doc.getElementById('effort').dispatchEvent(new win.Event('change'));doc.getElementById('closeSettings').click();
 assert.equal(posts.length,1);assert.equal(doc.getElementById('planBadge').hidden,false);
 doc.getElementById('prompt').value='首条消息';doc.getElementById('compose').dispatchEvent(new win.Event('submit',{cancelable:true}));await settle();
 assert.equal(posts[1][0],'/api/threads');assert.deepEqual(posts[1][1].target,{type:'project',projectId:'p'});assert.equal(posts[1][1].model,'m');assert.equal(posts[1][1].effort,'high');assert.equal(posts[1][1].mode,'plan');assert.equal(doc.getElementById('prompt').disabled,true);
 doc.getElementById('compose').dispatchEvent(new win.Event('submit',{cancelable:true}));await settle();assert.deepEqual(posts[2],posts[1]);
});
