import test from 'node:test';
import assert from 'node:assert/strict';
import {TranscriptStream, applyPatch} from '../desktop_bridge/transcript_stream.mjs';
import {transcriptRows} from '../static/transcript.mjs';

const user = {id:'u',type:'userMessage',content:[{type:'text',text:'hello'}]};
const agent = text => ({id:'a',type:'agentMessage',text});
const state = (items=[user]) => ({id:'chat',agentNickname:'Codex',turns:[],turnHistory:{kind:'canonical',history:{
  entitiesByKey:{tail:{turnId:'turn',status:'inProgress',items}},islands:[{entries:[{key:'tail',value:'tail'}]}]}}});
const frame = change => ({method:'thread-stream-state-changed',sourceClientId:'owner',params:{conversationId:'chat',hostId:'local',change}});
const baseline = (reducer, value=state()) => reducer.accept(frame({type:'snapshot',revision:5,conversationState:value}));
const patch = (revision, patches, acceptedTextChanges) => frame({type:'patches',baseRevision:revision-1,revision,patches,acceptedTextChanges});
const path = (...parts) => ['turnHistory','history','entitiesByKey','tail',...parts];

test('real patches produce growing public text once and completion removes thinking', () => {
  const reducer=new TranscriptStream('chat','owner');let live=baseline(reducer);
  assert.equal(transcriptRows({}, {...live,connected:true}).at(-1).status,'正在思考');
  live=reducer.accept(patch(6,[{op:'add',path:path('items',1),value:agent('第一段')} ]));
  assert.equal(live.turns[0].items[1].text,'第一段');
  live=reducer.accept(patch(7,[{op:'replace',path:path('items',1,'text'),value:'第一段\n第二段'}],[{delta:'\n第二段'}]));
  assert.equal(live.turns[0].items[1].text,'第一段\n第二段');
  const rows=transcriptRows({}, {...live,connected:true});
  assert.equal(rows.at(-1).messages.length,1);
  live=reducer.accept(patch(8,[{op:'replace',path:path('status'),value:'completed'}]));
  assert.equal(transcriptRows({},live).at(-1).status,'');
});

test('duplicate/old frames are ignored, revision gaps require a full fresh snapshot', () => {
  const reducer=new TranscriptStream('chat','owner');baseline(reducer);
  const message=patch(6,[{op:'add',path:path('items',1),value:agent('one')}]);
  reducer.accept(message);assert.equal(reducer.accept(message),null);
  assert.equal(baseline(reducer),null);
  assert.throws(()=>reducer.accept(patch(8,[])),/gap/);
  const fresh=reducer.accept(frame({type:'snapshot',revision:9,conversationState:state([user,agent('all')])}));
  assert.equal(fresh.turns[0].items.length,2);
});

test('wrong owner, wrong chat, remote host and private reasoning/tool output are excluded', () => {
  const reducer=new TranscriptStream('chat','owner'), s=state([user,agent('public'),{type:'reasoning',id:'r',text:'private'},{type:'commandExecution',id:'c',aggregatedOutput:'secret'}]);
  for(const mutation of [m=>m.sourceClientId='old-owner',m=>m.params.hostId='remote',m=>m.params.conversationId='other']) {
    const message=frame({type:'snapshot',revision:5,conversationState:s});mutation(message);assert.equal(reducer.accept(message),null);
  }
  const live=baseline(reducer,s);assert.equal(live.turns[0].items.length,2);
  assert.equal(JSON.stringify(live).includes('private'),false);assert.equal(JSON.stringify(live).includes('secret'),false);
});

test('Immer arrays insert/remove correctly and unsafe or missing paths fail closed', () => {
  let value={items:['one','three']};
  value=applyPatch(value,{op:'add',path:['items',1],value:'two'});
  assert.deepEqual(value.items,['one','two','three']);
  applyPatch(value,{op:'remove',path:['items',0]});assert.deepEqual(value.items,['two','three']);
  for(const path of [['__proto__','bad'],['constructor','prototype'],['missing','x'],['items',99]]) assert.throws(()=>applyPatch(value,{op:'replace',path,value:'x'}));
  assert.equal({}.bad,undefined);
});

test('public stream overrides stale REST history without duplicates or resurrected thinking', () => {
  const old={turns:[{id:'turn',status:'inProgress',items:[user,agent('short')]}]};
  const live={connected:true,turns:[{id:'turn',status:'completed',items:[user,agent('complete')]}]};
  const rows=transcriptRows(old,live,{turnId:'turn'});
  assert.equal(rows.length,2);assert.equal(rows.at(-1).status,'');assert.equal(rows.at(-1).messages[0].text,'complete');
});

test('queued-only/empty chats never show thinking; disconnects, questions and stops are distinct', () => {
  assert.deepEqual(transcriptRows({turns:[]},null),[]);
  const live={connected:true,turns:[{id:'turn',status:'inProgress',items:[user]}]};
  assert.equal(transcriptRows({},live,{online:false}).at(-1).status,'连接中断，正在重连');
  assert.equal(transcriptRows({},{...live,connected:false}).at(-1).status,'正在同步状态');
  assert.equal(transcriptRows({},live,{pending:[{}]}).at(-1).status,'等待你回答');
  live.turns[0].status='interrupted';const rows=transcriptRows({},live);
  assert.equal(rows.at(-1).text,'本轮已停止');assert.equal(rows.some(row=>row.status==='正在思考'),false);
});

test('assistant header keeps its identity before and after the first text and across segments', () => {
  const live={connected:true,nickname:'小助手',turns:[{id:'turn',status:'inProgress',items:[user]}]};
  const first=transcriptRows({},live).at(-1);
  live.turns[0].items.push(agent('first'),{...agent('second'),id:'b'});
  const after=transcriptRows({},live).at(-1);
  assert.equal(first.id,after.id);assert.equal(after.name,'小助手');assert.equal(after.messages.length,2);
});
