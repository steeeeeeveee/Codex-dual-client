import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID, webcrypto } from 'node:crypto';
const threadId = '01a0e10f-b76c-7d80-9b90-a9a18d7c3e63';
const source = fs.readFileSync(new URL('../desktop_bridge/owner_renderer.mjs', import.meta.url), 'utf8')
  .replace('./mobile_settings.mjs',new URL('../desktop_bridge/mobile_settings.mjs',import.meta.url).href)
  .replace('./plan_workflow.mjs',new URL('../desktop_bridge/plan_workflow.mjs',import.meta.url).href)
  .replace('./turn_control.mjs',new URL('../desktop_bridge/turn_control.mjs',import.meta.url).href)
  .replace('__CODEX_MOBILE_TEST_THREAD__', threadId);

function storage() {
  const value = {};
  Object.defineProperties(value, {
    getItem: { value: key => value[key] ?? null },
    setItem: { value: (key, data) => { value[key] = String(data); }, configurable: true },
  });
  return value;
}
async function moduleFor(store, shared=false) {
  globalThis.codexMobileLabJournal = async ({ operation, messageId, receipt,attachments }) => {
    if(operation==='media-validate')return attachments;
    if (operation === 'get') return JSON.parse(store.getItem(messageId) ?? 'null');
    if (operation === 'set') return store.setItem(messageId, JSON.stringify(receipt));
    return Object.keys(store).map(messageId => ({ messageId, receipt: JSON.parse(store[messageId]) }));
  };
  if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', { value: webcrypto });
  return import('data:text/javascript,' + encodeURIComponent((shared?source.replace(threadId,'*'):source) + '\n//' + randomUUID()));
}
function fixture() {
  const items = [], executed = new Set();
  const state = { appends: 0, mode: 'ok', owner: true };
  const owner = {
    assertThreadFollowerOwner() { if (!state.owner) throw Error('Lost ownership'); },
    getConversationCwd() { return 'C:/lab'; },
    getHostId() { return 'local'; },
    getConversation() { return state.conversation ??= {requests:[],resumeState:'resumed'}; },
    async sendRequest() { return {thread:{turns:[]},data:[]}; },
    turnCoordinator: {
      options: { wasMessageAccepted: (_thread, id) => executed.has(id), submissionHost:{getActiveTurnId:()=>null} },
      serverQueue: {isEnabled:()=>true, async load() {}},
      async loadMessages() {}, readMessages: () => items,
      async mobileAppendSingle(_thread, item) {
        owner.assertThreadFollowerOwner();
        if (state.mode === 'fail-before') throw Error('Disconnected before commit');
        state.appends++;
        const id = randomUUID();
        items.push({ ...item, clientUserMessageId: item.id, id });
        if (state.mode === 'fail-after') throw Error('Acknowledgment lost');
        return { messageId: id };
      },
    },
  };
  return { owner, items, executed, state };
}
function request(text = 'Test message') { return { conversationId: threadId, messageId: randomUUID(), text }; }

test('concurrent duplicate IDs append once and preserve later desktop edits', async () => {
  const mod = await moduleFor(storage()), f = fixture(), input = request();
  await Promise.all(Array.from({ length: 20 }, () => mod.handle(f.owner, input)));
  assert.equal(f.state.appends, 1);
  f.items[0].text = 'Edited on desktop';
  assert.equal((await mod.handle(f.owner, input)).status, 'queued');
  assert.equal(f.items[0].text, 'Edited on desktop');
  await assert.rejects(mod.handle(f.owner, { ...input, text: 'Different payload' }), /reused/);
});

test('video-only and mixed attachments use native files, not image input, and retry once',async()=>{
  const mod=await moduleFor(storage(),true),f=fixture(),input=request('');
  const video={id:randomUUID(),kind:'video',mime:'video/quicktime',localPath:'C:/media/original.mov',filename:'录屏.mov',sha256:'a'.repeat(64)};
  input.attachments=[video];
  await Promise.all([mod.handle(f.owner,input),mod.handle(f.owner,input)]);
  assert.equal(f.state.appends,1);assert.equal(f.items[0].context.imageAttachments.length,0);
  assert.equal(f.items[0].context.fileAttachments[0].path,video.localPath);
  assert.equal(f.items[0].context.fileAttachments[0].label,video.filename);
  assert.equal((await mod.snapshot(f.owner,{conversationId:threadId})).queue[0].attachments[0].kind,'video');
  const image={id:randomUUID(),localPath:'C:/media/full.jpg',filename:'图片.jpg',sha256:'b'.repeat(64)};
  await mod.handle(f.owner,{...request('图文混合'),attachments:[image,video]});
  assert.equal(f.items[1].context.imageAttachments.length,1);assert.equal(f.items[1].context.fileAttachments.length,1);
  await assert.rejects(mod.handle(f.owner,{...input,attachments:[{...video,sha256:'c'.repeat(64)}]}),/reused/);
});
test('desktop deletion is not resurrected after adapter restart', async () => {
  const store = storage(), f = fixture(), input = request();
  await (await moduleFor(store)).handle(f.owner, input);
  f.items.length = 0;
  assert.equal((await (await moduleFor(store)).handle(f.owner, input)).status, 'accepted-earlier');
  assert.equal(f.state.appends, 1);
});
test('lost acknowledgment reconciles stable client ID and unblocks following messages', async () => {
  const store = storage(), f = fixture(), input = request();
  f.state.mode = 'fail-after';
  await assert.rejects((await moduleFor(store)).handle(f.owner, input), /Acknowledgment lost/);
  f.state.mode = 'ok';
  const resumed = await moduleFor(store);
  assert.equal((await resumed.handle(f.owner, input)).status, 'queued');
  await resumed.handle(f.owner, request('Next'));
  assert.equal(f.state.appends, 2);
});
test('unknown outcome absent from history and queue blocks subsequent transfer', async () => {
  const store = storage(), f = fixture(), input = request();
  f.state.mode = 'fail-before';
  await assert.rejects((await moduleFor(store)).handle(f.owner, input));
  f.state.mode = 'ok';
  const resumed = await moduleFor(store);
  assert.equal((await resumed.handle(f.owner, input)).status, 'needs-review');
  await assert.rejects(resumed.handle(f.owner, request('Next')), /reconciliation/);
  assert.equal(f.state.appends, 0);
});
test('execution after lost acknowledgment is recognized without resubmission', async () => {
  const store = storage(), f = fixture(), input = request();
  f.state.mode = 'fail-after';
  await assert.rejects((await moduleFor(store)).handle(f.owner, input));
  f.items.length = 0; f.executed.add(input.messageId);
  assert.equal((await (await moduleFor(store)).handle(f.owner, input)).status, 'executed');
  assert.equal(f.state.appends, 1);
});
test('receipt storage failure and unapproved conversation cannot send', async () => {
  const store = storage(), f = fixture(), input = request();
  Object.defineProperty(store, 'setItem', { value() { throw Error('Disk full'); } });
  const mod = await moduleFor(store);
  await assert.rejects(mod.handle(f.owner, input), /Disk full/);
  await assert.rejects(mod.handle(f.owner, { ...input, conversationId: randomUUID() }), /Lab conversation/);
  assert.equal(f.state.appends, 0);
});
test('retired owner cannot enqueue', async () => {
  const mod = await moduleFor(storage()), f = fixture();
  f.state.owner = false;
  await assert.rejects(mod.handle(f.owner, request()), /ownership/);
  assert.equal(f.state.appends, 0);
});

test('phone and desktop answers accept once and old tokens cannot answer a reused RPC ID', async () => {
  const mod=await moduleFor(storage()), f=fixture();
  const question={id:1, method:'item/tool/requestUserInput', params:{threadId,turnId:'turn-1',questions:[{id:'pick',question:'Pick',options:[{label:'A'},{label:'B'}]}]}};
  f.owner.getConversation().requests.push(question);
  let dispatches=0;
  f.owner.replyWithUserInputResponse=(_id,rid,payload)=>{
    assert.equal(payload.answers.pick.answers[0],'B'); dispatches++;
    f.owner.getConversation().requests=f.owner.getConversation().requests.filter(item=>item.id!==rid);
  };
  const token=(await mod.snapshot(f.owner,{conversationId:threadId})).pending[0].clientRequestId;
  assert.throws(()=>mod.answer(f.owner,{conversationId:threadId,requestId:token,answers:{pick:'invalid'}}),/Invalid/);
  mod.answer(f.owner,{conversationId:threadId,requestId:token,answers:{pick:'B'}});
  assert.throws(()=>mod.answer(f.owner,{conversationId:threadId,requestId:token,answers:{pick:'B'}}),/expired/);
  f.owner.getConversation().requests.push({...question,params:{...question.params,turnId:'turn-2'}});
  const next=(await mod.snapshot(f.owner,{conversationId:threadId})).pending[0].clientRequestId;
  assert.notEqual(next,token);
  assert.throws(()=>mod.answer(f.owner,{conversationId:threadId,requestId:token,answers:{pick:'B'}}),/expired/);
  f.owner.replyWithUserInputResponse(threadId,1,{answers:{pick:{answers:['B']}}}); // desktop wins
  assert.throws(()=>mod.answer(f.owner,{conversationId:threadId,requestId:next,answers:{pick:'B'}}),/expired/);
  assert.equal(dispatches,2);
});

test('snapshot repairs a lost append receipt before allowing the next message', async () => {
  const mod=await moduleFor(storage()), f=fixture(), input=request();
  f.state.mode='fail-after';
  await assert.rejects(mod.handle(f.owner,input));
  assert.equal((await mod.snapshot(f.owner,{conversationId:threadId})).receipts[0].status,'queued');
  f.state.mode='ok';
  await mod.handle(f.owner,request('Next'));
  assert.equal(f.state.appends,2);
});

test('multi-chat snapshots preserve another chat question and reject cross-chat answers', async()=>{
  const mod=await moduleFor(storage(),true), f=fixture(), other=randomUUID();
  const conversations=new Map([threadId,other].map(id=>[id,{resumeState:'resumed',requests:[{id:1,method:'item/tool/requestUserInput',params:{threadId:id,questions:[{id:'pick',question:'Pick'}]}}]}]));
  f.owner.getConversation=id=>conversations.get(id);
  const a=await mod.snapshot(f.owner,{conversationId:threadId});
  const b=await mod.snapshot(f.owner,{conversationId:other});
  assert.notEqual(a.pending[0].clientRequestId,b.pending[0].clientRequestId);
  assert.throws(()=>mod.answer(f.owner,{conversationId:other,requestId:a.pending[0].clientRequestId,answers:{pick:'A'}}),/expired/);
  let called;
  f.owner.replyWithUserInputResponse=(id)=>{called=id;conversations.get(id).requests=[];};
  mod.answer(f.owner,{conversationId:threadId,requestId:a.pending[0].clientRequestId,answers:{pick:'A'}});
  assert.equal(called,threadId);assert.equal(conversations.get(other).requests.length,1);
});

test('deployed owner refuses remote host and skips unchanged history reads', async()=>{
  const mod=await moduleFor(storage(),true), f=fixture();let reads=0;
  f.owner.getConversationStreamRevision=()=>7;
  f.owner.sendRequest=async()=>{reads++;return{data:[]};};
  const a=await mod.snapshot(f.owner,{conversationId:threadId});
  const b=await mod.snapshot(f.owner,{conversationId:threadId,knownRevision:a.revision});
  assert.equal(reads,1);assert.equal(b.thread,undefined);
  f.owner.getHostId=()=> 'durable';
  await assert.rejects(mod.handle(f.owner,request()),/Local conversation/);
});

test('deployed owner cannot read, append or approve before acquiring the writer', async()=>{
  const mod=await moduleFor(storage(),true), f=fixture();
  for(const resumeState of ['needs_resume','resuming',undefined]){
    f.owner.getConversation().resumeState=resumeState;
    await assert.rejects(mod.snapshot(f.owner,{conversationId:threadId}),/not resumed/);
    await assert.rejects(mod.handle(f.owner,request()),/not resumed/);
    assert.throws(()=>mod.answer(f.owner,{conversationId:threadId,requestId:'old',decision:'accept'}),/not resumed/);
  }
  assert.equal(f.state.appends,0);
  f.owner.getConversation().resumeState='resumed';
  await mod.handle(f.owner,request());assert.equal(f.state.appends,1);
});

test('file approval needs visible changes, including after an unchanged revision poll', async()=>{
  const mod=await moduleFor(storage(),true), f=fixture();let reads=0, dispatched=0;
  f.owner.getConversation().requests=[{id:1,method:'item/fileChange/requestApproval',params:{threadId,itemId:'change'}}];
  f.owner.getConversationStreamRevision=()=>8;
  f.owner.replyWithFileChangeApprovalDecision=()=>{dispatched++;};
  const first=await mod.snapshot(f.owner,{conversationId:threadId});
  assert.throws(()=>mod.answer(f.owner,{conversationId:threadId,requestId:first.pending[0].clientRequestId,decision:'accept'}),/details unavailable/);
  f.owner.sendRequest=async()=>{reads++;return{data:[{id:'turn',items:[{id:'change',type:'fileChange',changes:[{path:'test.txt',kind:{type:'add'},diff:'+test'}]}]}]};};
  const second=await mod.snapshot(f.owner,{conversationId:threadId,knownRevision:first.revision});
  assert.equal(reads,1);assert.equal(second.items[0].changes[0].path,'test.txt');
  mod.answer(f.owner,{conversationId:threadId,requestId:second.pending[0].clientRequestId,decision:'accept'});
  assert.equal(dispatched,1);
});
