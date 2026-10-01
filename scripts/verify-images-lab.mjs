// Writable operations are restricted to the disposable desktop's private pipe.
import {LabClient} from '../desktop_bridge/lab_client.mjs';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const client=new LabClient(),evidence={startedAt:new Date().toISOString(),checks:[]};
const attachments=JSON.parse(fs.readFileSync(new URL('../runtime/image-lab-inputs.json',import.meta.url),'utf8'));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let tid,owner;
const call=async(method,params={})=>(await client.request(method,{hostId:'local',conversationId:tid,...params},owner)).result;
async function until(callback,limit=120000){const deadline=Date.now()+limit;while(Date.now()<deadline){const value=await callback();if(value)return value;await pause(1000);}throw Error('Image acceptance stage timed out');}
async function idle(count){return until(async()=>{const s=await call('thread-follower-mobile-lab-state');return !s.turnId&&s.queue.length===0&&s.thread?.turns.length>=count&&s.thread.turns.every(t=>!['inProgress'].includes(t.status))?s:null;});}
const describe='请描述所附图片中的图形颜色、形状和四位数字。不要调用工具或修改文件，只根据图片回答。';
function open(id){const root=new URL('../',import.meta.url);const result=spawnSync(fileURLToPath(new URL('.venv/Scripts/python.exe',root)),[fileURLToPath(new URL('scripts/open-image-lab-thread.py',root)),process.argv[2],id],{encoding:'utf8'});if(result.status!==0)throw Error(result.stderr||'Lab deep link failed');}
function answer(state){return state.thread.turns.flatMap(t=>t.items).filter(i=>i.type==='agentMessage').map(i=>i.text).join('\n');}
try{
 await client.connect();const caps=(await client.request('mobile-desktop-capabilities',{hostId:'local'})).result;
 assert(caps.imageInputs&&caps.imageOutputs);assert.equal(caps.projects.length,1);evidence.project=caps.projects[0];
 if(process.argv.includes('--verify-existing')){
  const previous=JSON.parse(fs.readFileSync(new URL('../runtime/image-lab-acceptance.json',import.meta.url),'utf8'));Object.assign(evidence,previous);delete evidence.error;
  tid=previous.projectThread;owner=await until(()=>client.findOwner(tid));const project=await idle(4);assert.equal(project.thread.turns.length,4);
  assert.equal(project.thread.turns.flatMap(t=>t.items).filter(i=>i.type==='userMessage'&&i.content.filter(p=>['image','localImage'].includes(p.type)).length===2).length,1);
  const created=(await client.request('mobile-desktop-creation-status',{hostId:'local',requestId:previous.independentRequest.requestId})).result;
  tid=created.threadId;owner=await until(()=>client.findOwner(tid));const independent=await idle(2);assert.equal(independent.thread.turns.length,2);assert.match(answer(independent),/7319/);
  const initial=independent.thread.turns[0].items.find(i=>i.type==='userMessage');assert.equal(previous.independentRequest.text,'');assert.equal(initial.content.filter(p=>['image','localImage'].includes(p.type)).length,1);
  assert.equal(initial.content.filter(p=>p.type==='text').map(p=>p.text).join('').split('## My request:').at(-1).trim(),'');
  evidence.independentThread=tid;evidence.independentTurns=independent.thread.turns;evidence.checks.push('projectless pure-image first turn has no user placeholder and real model recognizes it');evidence.passed=true;
  console.log(JSON.stringify({stage:'passed',checks:evidence.checks}));
 }else{
 const request=process.argv.includes('--resume')?JSON.parse(fs.readFileSync(new URL('../runtime/image-lab-acceptance.json',import.meta.url),'utf8')).projectRequest:{hostId:'local',requestId:randomUUID(),messageId:randomUUID(),target:{type:'project',projectId:caps.projects[0].id},model:'gpt-6-sol',effort:'medium',text:describe,attachments:[attachments[0]]};
 evidence.projectRequest=request;
 const duplicate=await Promise.allSettled([client.request('mobile-desktop-create',request),client.request('mobile-desktop-create',request)]);
 const created=await until(async()=>{const result=(await client.request('mobile-desktop-creation-status',{hostId:'local',requestId:request.requestId})).result;return result.status==='created'?result:null;});
 tid=created.threadId;open(tid);owner=await until(()=>client.findOwner(tid));evidence.projectThread=tid;
 await call('thread-follower-mobile-lab-append',{messageId:request.messageId,text:request.text,attachments:request.attachments});
 const first=process.argv.includes('--resume')?await call('thread-follower-mobile-lab-state'):await idle(1);evidence.firstTurn=first.thread.turns;
 assert.match(answer(first),/7319/);assert(first.thread.turns.flatMap(t=>t.items).some(i=>i.type==='userMessage'&&i.content.some(p=>['image','localImage'].includes(p.type))));
 evidence.checks.push('project image reaches model; image details recognized');console.log(JSON.stringify({stage:'project-image-recognized',threadId:tid,reply:answer(first)}));
 let waiting=first.pending?.length?first:null;
 if(!waiting){await call('thread-follower-mobile-lab-control',{operation:'set-mode',mode:'plan'});await call('thread-follower-mobile-lab-append',{messageId:randomUUID(),text:'Use request_user_input to ask exactly one question with choices Continue and Cancel, then wait. After my answer reply only A_DONE. Do not run commands or modify files.'});waiting=await until(async()=>{const value=await call('thread-follower-mobile-lab-state');return value.pending?.length?value:null;});}
 if(waiting.settings.next.mode!=='default')await call('thread-follower-mobile-lab-control',{operation:'set-mode',mode:'default'});
 const b={messageId:randomUUID(),text:'',attachments},c={messageId:randomUUID(),text:'上一条包含两张图片。'+describe};
 await Promise.all([call('thread-follower-mobile-lab-append',b),call('thread-follower-mobile-lab-append',b)]);
 await call('thread-follower-mobile-lab-control',{operation:'native-append',...c});
 const held=await call('thread-follower-mobile-lab-control',{operation:'inspect',messageIds:[request.messageId,b.messageId,c.messageId]});
 assert.equal(held.messages.length,2);assert.equal(held.messages[0].context.imageAttachments.length,2);assert.equal(held.messages[0].text,'');
 evidence.heldQueue=held.messages;
 const question=waiting.pending[0],answers=Object.fromEntries(question.params.questions.map(q=>[q.id,q.options[0].label]));
 await call('thread-follower-mobile-lab-answer',{requestId:question.clientRequestId,answers});
 const completed=await idle(4);const inspection=await call('thread-follower-mobile-lab-control',{operation:'inspect',messageIds:[request.messageId,b.messageId,c.messageId]});
 assert.equal(inspection.acceptedIds.length,4);assert.equal(completed.thread.turns.length,4);assert.match(answer(completed),/7319/);
 const users=completed.thread.turns.flatMap(t=>t.items).filter(i=>i.type==='userMessage');assert.equal(users.filter(u=>u.content.filter(p=>['image','localImage'].includes(p.type)).length===2).length,1);
 evidence.projectTurns=completed.thread.turns;evidence.checks.push('pure-image native queue, two attachments, native text coexist, duplicate ID executes once');
 console.log(JSON.stringify({stage:'native-image-queue-passed',turns:completed.thread.turns.length}));
 const independent={hostId:'local',requestId:randomUUID(),messageId:randomUUID(),target:{type:'projectless'},model:'gpt-6-sol',effort:'medium',text:'',attachments:[attachments[1]]};evidence.independentRequest=independent;
 await client.request('mobile-desktop-create',independent);
 const created2=await until(async()=>{const result=(await client.request('mobile-desktop-creation-status',{hostId:'local',requestId:independent.requestId})).result;return result.status==='created'?result:null;});
 tid=created2.threadId;open(tid);owner=await until(()=>client.findOwner(tid));await call('thread-follower-mobile-lab-append',{messageId:independent.messageId,text:'',attachments:independent.attachments});await idle(1);
 await call('thread-follower-mobile-lab-append',{messageId:randomUUID(),text:'请根据上一条图片，'+describe});const last=await idle(2);
 assert.match(answer(last),/7319/);const initial=last.thread.turns[0].items.find(i=>i.type==='userMessage');assert.equal(independent.text,'');const visibleText=initial.content.filter(p=>p.type==='text').map(p=>p.text).join('');assert.equal(visibleText.split('## My request:').at(-1).trim(),'');assert.equal(initial.content.filter(p=>['image','localImage'].includes(p.type)).length,1);
 evidence.independentThread=tid;evidence.independentTurns=last.thread.turns;evidence.checks.push('projectless pure-image first turn creates with no placeholder and subsequent model sees image');
 evidence.passed=true;console.log(JSON.stringify({stage:'passed',checks:evidence.checks}));
 }
}catch(error){evidence.error=error.message;console.error(error.stack);process.exitCode=1;}
finally{client.close();fs.writeFileSync(new URL('../runtime/image-lab-acceptance.json',import.meta.url),JSON.stringify(evidence,null,2));}
