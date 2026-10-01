// Resume only the disposable lab's completed project Plan after a desktop restart.
import {LabClient} from '../desktop_bridge/lab_client.mjs';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
const file=new URL('../runtime/plan-project-acceptance.json',import.meta.url);
const evidence=JSON.parse(fs.readFileSync(file)),client=new LabClient();
const tid=evidence.created.threadId;
const until=async fn=>{for(let n=0;n<100;n++){const v=await fn();if(v)return v;await new Promise(r=>setTimeout(r,1000));}throw Error('Restart verification timed out');};
try {
 await client.connect();
 const owner=await until(()=>client.findOwner(tid));
 const call=async(method,params={})=>(await client.request(method,{hostId:'local',conversationId:tid,...params},owner)).result;
 const state=await until(async()=>{const s=await call('thread-follower-mobile-lab-state');return s.thread?s:null;});
 assert(state.thread.turns.flatMap(t=>t.items).some(i=>i.type==='plan'));
 assert.equal(state.turnId,null);
 assert.equal(state.queue.length,0);
 evidence.restartInitial={mode:state.settings.next.mode,planReview:state.planReview,historyPreserved:true};
 // Native desktop does not persist its in-memory confirmation card or Plan
 // selection. Do not fabricate it or replay adoption. Explicitly select Plan
 // and ask for a fresh native confirmation, just as a user would after restart.
 assert.equal((await call('thread-follower-mobile-lab-settings',{operation:'settings',requestId:randomUUID(),version:state.settings.version,model:state.settings.next.model,effort:state.settings.next.effort,mode:'plan'})).status,'applied');
 const refinementId=randomUUID();
 await call('thread-follower-mobile-lab-append',{messageId:refinementId,text:'The desktop restarted. We are continuing planning only. Reconfirm exactly the previous proposed plan using the native proposed_plan format. Do not implement and do not use tools. The plan remains: when implemented, do not use tools, do not change files, reply only PLAN_IMPLEMENTED.'});
 const review=await until(async()=>{const s=await call('thread-follower-mobile-lab-state');return !s.turnId&&s.planReview?s:null;});
 const input={operation:'implement-plan',requestId:randomUUID(),messageId:randomUUID(),version:review.settings.version,planId:review.planReview.id,turnId:review.planReview.turnId};
 assert.equal((await call('thread-follower-mobile-lab-settings',input)).status,'applied');
 assert.equal((await call('thread-follower-mobile-lab-settings',input)).status,'applied');
 const done=await until(async()=>{const s=await call('thread-follower-mobile-lab-state');return !s.turnId&&s.thread.turns.some(t=>t.items.some(i=>i.type==='agentMessage'&&i.text.includes('PLAN_IMPLEMENTED')))?s:null;});
 assert.equal(done.settings.next.mode,'default');
 const inspect=await call('thread-follower-mobile-lab-control',{operation:'inspect',messageIds:[evidence.creationRequest.messageId,refinementId,input.messageId]});
 assert.equal(inspect.acceptedIds.length,3);
 assert.equal(inspect.turnSettings.at(-1).params.collaborationMode.mode,'default');
 evidence.restart={passed:true,planId:review.planReview.id,acceptedIds:inspect.acceptedIds,turnSettings:inspect.turnSettings};
 console.log(JSON.stringify({stage:'restart-passed',threadId:tid,accepted:3}));
}catch(e){evidence.restart={passed:false,error:e.message};console.error(e.message);process.exitCode=1;}
finally{client.close();fs.writeFileSync(file,JSON.stringify(evidence,null,2));}
