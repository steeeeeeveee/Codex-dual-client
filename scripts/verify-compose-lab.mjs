// Only the disposable lab pipe is writable by this acceptance runner.
import {LabClient} from '../desktop_bridge/lab_client.mjs';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
const client = new LabClient();
const evidence = {startedAt:new Date().toISOString()};
const firstText='This is an isolated acceptance test. Do not modify files or run commands. Use the request_user_input tool to ask exactly one question with choices Continue and Cancel, then wait. After my answer reply only A_DONE.';
const pause = ms => new Promise(resolve=>setTimeout(resolve,ms));
let tid, owner;
const call = async (method,params={}) => (await client.request(method,{hostId:'local',conversationId:tid,...params},owner)).result;
async function until(callback, limit=90000) {
  const deadline=Date.now()+limit;
  while(Date.now()<deadline){const result=await callback();if(result)return result;await pause(1200);}
  throw Error('Acceptance stage timed out');
}
try {
  await client.connect();
  const caps=(await client.request('mobile-desktop-capabilities',{hostId:'local'})).result;
  assert(caps.projects.some(p=>p.id==='mobile-compose-test'));
  const create=process.argv.includes('--resume')?JSON.parse(fs.readFileSync(new URL('../runtime/compose-queue-acceptance.json',import.meta.url))).creationRequest:{hostId:'local',requestId:randomUUID(),messageId:randomUUID(),target:{type:'project',projectId:'mobile-compose-test'},model:'gpt-6-sol',effort:'medium',text:'Do not use tools. Reply only PROJECT_CREATED.'};
  evidence.creationRequest=create;
  const replies=await Promise.allSettled(Array.from({length:3},()=>client.request('mobile-desktop-create',create)));
  const created=await until(async()=>{const r=(await client.request('mobile-desktop-creation-status',{hostId:'local',requestId:create.requestId})).result;return r.status==='created'?r:null;});
  assert.equal(created.status,'created');tid=created.threadId;owner=await client.findOwner(tid);
  assert(owner);evidence.created=created;evidence.duplicateCreationReplies=replies.map(r=>r.status==='fulfilled'?r.value.result.status:'confirmation-lost');
  console.log(JSON.stringify({stage:'created',threadId:tid,duplicateStatuses:evidence.duplicateCreationReplies}));
  await call('thread-follower-mobile-lab-state');
  await until(async()=>{const s=await call('thread-follower-mobile-lab-state');return !s.turnId&&s.thread?.turns?.some(t=>t.status==='completed')?s:null;});
  await call('thread-follower-mobile-lab-control',{operation:'set-mode',mode:'plan'});
  const a=randomUUID();
  await call('thread-follower-mobile-lab-append',{messageId:a,text:firstText});
  const waiting=await until(async()=>{const s=await call('thread-follower-mobile-lab-state');return s.pending?.length?s:null;});
  evidence.before=waiting.settings;assert.equal(waiting.settings.current.model,'gpt-6-sol');
  const b=randomUUID(),c=randomUUID();
  await call('thread-follower-mobile-lab-append',{messageId:b,text:'Do not use tools. Reply only B_DONE.'});
  await call('thread-follower-mobile-lab-control',{operation:'native-append',messageId:c,text:'Do not use tools. Reply only C_DONE.'});
  const request={operation:'settings',requestId:randomUUID(),version:waiting.settings.version,model:'gpt-6-luna',effort:'high'};
  const applied=await call('thread-follower-mobile-lab-settings',request);
  assert.equal(applied.status,'applied');
  assert.equal((await call('thread-follower-mobile-lab-settings',request)).status,'applied');
  const conflict=await call('thread-follower-mobile-lab-settings',{...request,requestId:randomUUID(),model:'gpt-6-sol'});
  assert.equal(conflict.status,'conflict');
  const during=await call('thread-follower-mobile-lab-state');
  assert.equal(during.settings.current.model,'gpt-6-sol');assert.equal(during.settings.next.model,'gpt-6-luna');
  assert.equal(during.queue.length,2);evidence.during=during.settings;evidence.conflict=conflict;
  console.log(JSON.stringify({stage:'queued-model-change',settings:during.settings,queue:2}));
  const question=waiting.pending[0],answers=Object.fromEntries(question.params.questions.map(q=>[q.id,q.options[0].label]));
  await call('thread-follower-mobile-lab-answer',{requestId:question.clientRequestId,answers});
  await assert.rejects(call('thread-follower-mobile-lab-answer',{requestId:question.clientRequestId,answers}),/expired|answered/);
  const completed=await until(async()=>{const s=await call('thread-follower-mobile-lab-state');return !s.turnId&&s.thread?.turns?.length>=4&&s.queue.length===0?s:null;},120000);
  const inspect=await call('thread-follower-mobile-lab-control',{operation:'inspect',messageIds:[create.messageId,a,b,c]});
  assert.equal(inspect.acceptedIds.length,4);
  evidence.turnSettings=inspect.turnSettings;evidence.turns=completed.thread.turns;
  const turns=inspect.turnSettings.slice(-3);
  assert.equal(turns[0].params.collaborationMode?.settings.model??turns[0].params.model,'gpt-6-sol');
  for(const turn of turns.slice(1)){
    assert.equal(turn.params.collaborationMode?.settings.model??turn.params.model,'gpt-6-luna');
    assert.equal(turn.params.collaborationMode?.settings.reasoning_effort??turn.params.reasoningEffort??turn.params.effort,'high');
  }
  evidence.passed=true;
  console.log(JSON.stringify({stage:'passed',threadId:tid,turnSettings:turns}));
}catch(error){evidence.error=String(error.message);console.error(error.message);process.exitCode=1;}
finally{client.close();fs.writeFileSync(new URL('../runtime/compose-queue-acceptance.json',import.meta.url),JSON.stringify(evidence,null,2));}
