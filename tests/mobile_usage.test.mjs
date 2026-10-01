import test from 'node:test';
import assert from 'node:assert/strict';
import {readUsage,selectWindows} from '../desktop_bridge/mobile_usage.mjs';
import {renderUsage,resetLabel,UsageController} from '../static/usage.mjs';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
const window=(usedPercent,windowDurationMins,resetsAt=2000000000)=>({usedPercent,windowDurationMins,resetsAt});
test('overall bucket, exact durations, partial windows and clamped fractional values',()=>{
 assert.deepEqual(selectWindows({rateLimitsByLimitId:{codex:{primary:window(98.4,300),secondary:window(51,10080)},codex_model:{primary:window(0,300)}}}),{fiveHour:{remainingPercent:100-98.4,resetsAt:2000000000},weekly:{remainingPercent:49,resetsAt:2000000000}});
 assert.equal(selectWindows({rateLimits:{primary:window(120,300)}}).fiveHour.remainingPercent,0);
 assert.equal(selectWindows({rateLimits:{secondary:window(-1,10080)}}).weekly.remainingPercent,100);
 for(const data of [{rateLimits:{primary:window(NaN,300)}},{rateLimits:{primary:window(5,301)}},{rateLimitsByLimitId:{codex_x:{primary:window(5,300)}}},{rateLimits:{limitId:'codex_x',primary:window(5,300)}}])assert.deepEqual(selectWindows(data),{fiveHour:null,weekly:null});
});
test('read-only account proof and sanitized response; switch during read invalidates',async()=>{
 const calls=[];let account={type:'chatgpt',email:'fixture@example.invalid'};
 const send=async(method,params)=>{calls.push([method,params]);return method==='account/read'?{account}:{rateLimits:{primary:window(20,300)}};};
 const value=await readUsage(send);assert.equal(value.status,'fresh');assert.match(value.accountKey,/^[a-f0-9]{64}$/);assert(!JSON.stringify(value).includes(account.email));assert.deepEqual(calls.map(c=>c[0]),['account/read','account/rateLimits/read','account/read']);
 let count=0;const switched=await readUsage(async method=>method==='account/read'?{account:{type:'chatgpt',email:++count===1?'one':'two'}}:{rateLimits:{primary:window(10,300)}});assert.equal(switched.reason,'account-changed');assert.equal(switched.windows,undefined);
 const loggedOut=await readUsage(async()=>({account:null}));assert.equal(loggedOut.reason,'login-required');
});
function fixture(){const dom=new JSDOM(readFileSync(new URL('../static/index.html',import.meta.url),'utf8'),{pretendToBeVisual:true});return {dom,card:dom.window.document.getElementById('usageCard')};}
test('card distinguishes zero, missing, exact bar values, historical and reset due',()=>{
 const {dom,card}=fixture();try{
 renderUsage(card,{status:'stale',fetchedAt:1790576000,windows:{fiveHour:{remainingPercent:0,resetsAt:1},weekly:null}});
 assert.equal(card.querySelector('.usagePercent').textContent,'0%');assert.match(card.textContent,/已用尽/);assert.match(card.textContent,/暂不可用/);assert.match(card.textContent,/历史数据/);assert.match(card.textContent,/重置时间已到/);
 for(const [percent,color] of [[70,'green'],[69.6,'amber'],[30,'amber'],[29.9,'red']]){renderUsage(card,{status:'fresh',windows:{fiveHour:{remainingPercent:percent}}});const tile=card.querySelector('[data-window=fiveHour]');assert(tile.classList.contains(color));assert.equal(tile.querySelector('progress').value,percent);}
 assert.equal(resetLabel(null),'重置时间暂不可用');
 }finally{dom.window.close();}
});
test('single inflight query; logout ignores delayed response; foreground refresh',async()=>{
 const {dom,card}=fixture();let resolve,calls=0;
 const controller=new UsageController(card,async()=>{calls++;return await new Promise(r=>resolve=r);},dom.window.document);
 controller.setAuthenticated(true);controller.refresh(true);card.querySelector('button').click();assert.equal(calls,1);
 controller.setAuthenticated(false);resolve({status:'fresh',windows:{}});await new Promise(r=>setImmediate(r));assert.equal(card.hidden,true);
 controller.setAuthenticated(true);assert.equal(calls,2);resolve({status:'fresh',windows:{}});await new Promise(r=>setImmediate(r));assert.equal(card.hidden,false);
 controller.setAuthenticated(false);dom.window.close();
});

test('background stops timer and queries; foreground performs a fresh read',async()=>{
 const {dom,card}=fixture();let calls=0;
 const controller=new UsageController(card,async()=>{calls++;return {status:'fresh',windows:{}};},dom.window.document);
 controller.setAuthenticated(true);await controller.inflight.promise;assert.equal(calls,1);assert(controller.timer);
 Object.defineProperty(dom.window.document,'hidden',{configurable:true,value:true});dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));
 await controller.refresh(true);assert.equal(calls,1);
 Object.defineProperty(dom.window.document,'hidden',{configurable:true,value:false});dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));
 await controller.inflight.promise;assert.equal(calls,2);
 controller.setAuthenticated(false);dom.window.close();
});
