// Writes only the disposable, isolated desktop lab. Never the production pipe.
import {LabClient} from '../desktop_bridge/lab_client.mjs';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
const client=new LabClient(), evidence={startedAt:new Date().toISOString()};
const project=process.argv.includes('--project'), leavePlan=process.argv.includes('--leave-plan');
const output=new URL(project?'../runtime/plan-project-acceptance.json':'../runtime/plan-live-acceptance.json',import.meta.url);
let tid, owner;
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,limit=120000){const end=Date.now()+limit;while(Date.now()<end){const value=await fn();if(value)return value;await pause(1200);}throw Error('Plan acceptance timed out');}
const call=async(method,params={})=>(await client.request(method,{hostId:'local',conversationId:tid,...params},owner)).result;
try {
 await client.connect();
 const caps=(await client.request('mobile-desktop-capabilities',{hostId:'local'})).result;
 assert.equal(caps.planMode,true);
 const model=caps.models.find(m=>m.id==='gpt-6-sol');assert(model);
 const create={hostId:'local',requestId:randomUUID(),messageId:randomUUID(),target:project?{type:'project',projectId:caps.projects[0]?.id}:{type:'projectless'},model:model.id,effort:model.defaultEffort,mode:'plan',text:'This is an isolated native Plan mode acceptance exercise. Do not edit files or execute commands. Before giving a plan, use request_user_input to ask exactly one question: Proceed with this test? Offer Continue and Cancel and wait for the answer. After Continue, produce a very short final proposed plan using the native proposed_plan format. The entire plan must be: when implemented, do not use tools, do not change files, reply only PLAN_IMPLEMENTED. Do not implement until I explicitly adopt the plan.'};
 evidence.creationRequest=create;
 await client.request('mobile-desktop-create',create);
 const created=await until(async()=>{const r=(await client.request('mobile-desktop-creation-status',{hostId:'local',requestId:create.requestId})).result;return r.status==='created'&&r.ready?r:null;});
 tid=created.threadId;owner=await client.findOwner(tid);assert(owner);evidence.created=created;
 console.log(JSON.stringify({stage:'created-plan',threadId:tid}));
 const waiting=await until(async()=>{const s=await call('thread-follower-mobile-lab-state');return s.pending?.length?s:null;});
 assert.equal(waiting.settings.current.mode,'plan');assert.equal(waiting.settings.next.mode,'plan');evidence.question=waiting.pending;
 const question=waiting.pending.find(p=>p.method==='item/tool/requestUserInput'||p.method==='mobile/asyncQuestion');assert(question);
 const q=question.params.questions[0], choice=q.options.find(o=>/Continue/i.test(o.label))??q.options[0];
 // Change next mode while a real native question is blocking the current turn.
 const change={operation:'settings',requestId:randomUUID(),version:waiting.settings.version,model:waiting.settings.next.model,effort:waiting.settings.next.effort,mode:'default'};
 const applied=await call('thread-follower-mobile-lab-settings',change);assert.equal(applied.status,'applied');
 const during=await call('thread-follower-mobile-lab-state');assert.equal(during.settings.current.mode,'plan');assert.equal(during.settings.next.mode,'default');
 const conflict=await call('thread-follower-mobile-lab-settings',{...change,requestId:randomUUID(),mode:'plan'});assert.equal(conflict.status,'conflict');
 const reset=await call('thread-follower-mobile-lab-settings',{...change,requestId:randomUUID(),version:during.settings.version,mode:'plan'});assert.equal(reset.status,'applied');
 await call('thread-follower-mobile-lab-answer',{requestId:question.clientRequestId,answers:{[q.id]:choice.label}});
 await assert.rejects(call('thread-follower-mobile-lab-answer',{requestId:question.clientRequestId,answers:{[q.id]:choice.label}}),/expired|answered/);
 const plan=await until(async()=>{const s=await call('thread-follower-mobile-lab-state');return !s.turnId&&s.planReview?s:null;});
 evidence.plan=plan.planReview;assert(plan.thread.turns.flatMap(t=>t.items).some(i=>i.type==='plan'));
 console.log(JSON.stringify({stage:'native-plan-confirmation',threadId:tid,planId:plan.planReview.id}));
 if(leavePlan){evidence.passed=true;evidence.leftForRestart=true;console.log(JSON.stringify({stage:'left-plan-for-restart',threadId:tid}));client.close();fs.writeFileSync(output,JSON.stringify(evidence,null,2));process.exit(0);}
 const implement={operation:'implement-plan',requestId:randomUUID(),messageId:randomUUID(),version:plan.settings.version,planId:plan.planReview.id,turnId:plan.planReview.turnId};
 const ack=await call('thread-follower-mobile-lab-settings',implement);assert.equal(ack.status,'applied');
 assert.equal((await call('thread-follower-mobile-lab-settings',implement)).status,'applied');
 const done=await until(async()=>{const s=await call('thread-follower-mobile-lab-state');return !s.turnId&&s.thread?.turns?.some(t=>t.items.some(i=>i.type==='agentMessage'&&i.text.includes('PLAN_IMPLEMENTED')))?s:null;});
 assert.equal(done.settings.next.mode,'default');assert.equal(done.planReview,null);
 const inspect=await call('thread-follower-mobile-lab-control',{operation:'inspect',messageIds:[create.messageId,implement.messageId]});
 assert.equal(inspect.acceptedIds.length,2);
 assert.equal(inspect.turnSettings.at(-1).params.collaborationMode.mode,'default');
 const texts=done.thread.turns.flatMap(t=>t.items).filter(i=>i.type==='userMessage').flatMap(i=>i.content).filter(p=>p.type==='text');
 assert.equal(texts.filter(p=>p.text.startsWith('PLEASE IMPLEMENT THIS PLAN:')).length,1);
 evidence.turnSettings=inspect.turnSettings;evidence.passed=true;
 console.log(JSON.stringify({stage:'passed',threadId:tid,accepted:2,finalMode:'default'}));
} catch(e){evidence.error=String(e.stack);console.error(e.message);process.exitCode=1;}
finally{client.close();fs.writeFileSync(output,JSON.stringify(evidence,null,2));}
