import test from 'node:test';
import assert from 'node:assert/strict';
import {controlTurn,turnControlView,resumeQueuedAfterPause} from '../desktop_bridge/turn_control.mjs';

function fixture(){
  const state={turns:[{turnId:'a',status:'inProgress',items:[{type:'userMessage'}]}]};let active='a';const calls=[];
  const owner={getConversation:()=>state,turnCoordinator:{options:{submissionHost:{getActiveTurnId:()=>active}}},
    async interruptConversation(...args){calls.push(args);state.turns[0].status='interrupted';active=null;return 'a';},
    async startEmptyTurn(...args){calls.push(args);state.turns.push({turnId:'b',status:'inProgress'});active='b';}};
  return {owner,state,calls};
}
test('pause only the expected turn and retry does not interrupt again',async()=>{
  const f=fixture();const request={conversationId:'chat',operation:'pause-turn',turnId:'a'};
  await controlTurn(f.owner,request);await controlTurn(f.owner,request);
  assert.deepEqual(f.calls,[['chat','user-stop','a']]);
  assert.equal(turnControlView(f.owner,'chat').resumableTurnId,'a');
});
test('continue uses native empty input and refuses stale double clicks',async()=>{
  const f=fixture();await controlTurn(f.owner,{conversationId:'chat',operation:'pause-turn',turnId:'a'});
  await controlTurn(f.owner,{conversationId:'chat',operation:'resume-turn',turnId:'a'});
  assert.deepEqual(f.calls[1],['chat',{continuationInput:[],turnTrigger:'mobile_resume'}]);
  assert.equal(turnControlView(f.owner,'chat').canPause,true);
  await assert.rejects(controlTurn(f.owner,{conversationId:'chat',operation:'resume-turn',turnId:'a'}),/暂停任务已改变/);
});
test('stale pause never stops a newer turn and completed work cannot resume',async()=>{
  const f=fixture();await assert.rejects(controlTurn(f.owner,{conversationId:'chat',operation:'pause-turn',turnId:'old'}),/本轮已结束/);
  f.state.turns[0].status='completed';assert.equal(turnControlView(f.owner,'chat').resumableTurnId,null);
  assert.deepEqual(f.calls,[]);
});
test('an active goal is paused before cancelling its expected turn',async()=>{
  const f=fixture();f.state.threadGoal={status:'active'};
  f.owner.sendRequest=async(method,params)=>{f.calls.push([method,params]);return {goal:{status:'paused'}};};
  f.owner.updateConversationState=(_,update)=>update(f.state);
  await controlTurn(f.owner,{conversationId:'chat',operation:'pause-turn',turnId:'a'});
  assert.deepEqual(f.calls[0],['thread/goal/set',{threadId:'chat',status:'paused'}]);
  assert.equal(f.state.threadGoal.status,'paused');
});
test('pause waits for the current user input to be materialized',async()=>{
  const f=fixture();f.state.turns[0].items=[];
  assert.equal(turnControlView(f.owner,'chat').canPause,false);
  await assert.rejects(controlTurn(f.owner,{conversationId:'chat',operation:'pause-turn',turnId:'a'}),/消息尚在启动/);
  assert.deepEqual(f.calls,[]);
});
test('sending after interruption restarts the native queue once',async()=>{
  const f=fixture();await controlTurn(f.owner,{conversationId:'chat',operation:'pause-turn',turnId:'a'});
  let resumes=0;
  f.owner.turnCoordinator.serverQueue={isEnabled:()=>true,load:async()=>{},read:()=>[{id:'queued'}]};
  f.owner.sendRequest=async(method,params)=>{assert.equal(method,'thread/queue/start');assert.deepEqual(params,{threadId:'chat',queuedSubmissionId:'queued'});resumes++;await f.owner.startEmptyTurn('chat',{});};
  await resumeQueuedAfterPause(f.owner,'chat');await resumeQueuedAfterPause(f.owner,'chat');
  assert.equal(resumes,1);
});
