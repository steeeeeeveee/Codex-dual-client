import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createJournal,handle as mainJournal} from '../desktop_bridge/owner_journal.cjs';
import {desktopOperation} from '../desktop_bridge/desktop_creation.mjs';
import {settingsView,modelCatalog,validateSelection} from '../desktop_bridge/mobile_settings.mjs';
import {selectionForModel,newestSettings} from '../static/settings.mjs';
const catalog=[{model:'model-a',displayName:'Model A',isDefault:true,defaultReasoningEffort:'low',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'}]}];
function fixture(t){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'mobile-compose-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  globalThis.codexMobileLabJournal=createJournal(directory,'*');
  const state={creates:0,appends:0};
  const api={projects:async()=>[{id:'p',name:'Project'}],send:async()=>({data:catalog}),
    create:async params=>{state.creates++;const result={status:'created',conversationId:randomUUID(),firstTurn:{status:'not-requested'}};await params.onSettled(result);return {result};},append:async()=>{state.appends++;}};
  const request={hostId:'local',requestId:randomUUID(),messageId:randomUUID(),target:{type:'project',projectId:'p'},model:'model-a',effort:'high',text:'First message'};
  return {api,state,request};
}
test('parallel creation and retry across renderer calls create and enqueue once',async t=>{
  const {api,state,request}=fixture(t);
  await Promise.all(Array.from({length:12},()=>desktopOperation(api,'mobile-desktop-create',request)));
  const receipt=await desktopOperation(api,'mobile-desktop-creation-status',request);
  assert.equal(receipt.status,'created');assert.equal(state.creates,1);assert.equal(state.appends,1);
  assert.deepEqual(await desktopOperation(api,'mobile-desktop-create',request),receipt);
  await assert.rejects(desktopOperation(api,'mobile-desktop-create',{...request,text:'changed'}),/reused/);
});
test('late creation callback reconciles ambiguous outcome without another create',async t=>{
  const {api,state,request}=fixture(t);let settle;
  api.create=async p=>{state.creates++;settle=p.onSettled;return {result:{status:'outcome-unknown'}};};
  assert.equal((await desktopOperation(api,'mobile-desktop-create',request)).status,'uncertain');
  await desktopOperation(api,'mobile-desktop-create',request);assert.equal(state.creates,1);
  const tid=randomUUID();await settle({status:'created',conversationId:tid});
  assert.equal((await desktopOperation(api,'mobile-desktop-creation-status',request)).threadId,tid);
});
test('first append failure retains original created thread for shared-queue reconciliation',async t=>{
  const {api,state,request}=fixture(t);api.append=async()=>{throw Error('lost acknowledgement');};
  const created=await desktopOperation(api,'mobile-desktop-create',request);
  assert.equal(created.status,'created');
  assert.equal((await desktopOperation(api,'mobile-desktop-create',request)).threadId,created.threadId);
  assert.equal(state.creates,1);
});
test('native initialization failure preserves thread identity but cannot dispatch first input',async t=>{
  const {api,state,request}=fixture(t);
  api.create=async p=>{const result={status:'created',conversationId:randomUUID(),firstTurn:{status:'not-started'}};await p.onSettled(result);return {result};};
  assert.equal((await desktopOperation(api,'mobile-desktop-create',request)).ready,false);
  assert.equal(state.appends,0);
});
test('creation discovery excludes secondary and floating windows at main-process boundary',()=>{
  const secondary={senderFrame:{url:'app://-/avatar-overlay'},sender:{}};
  assert.equal(mainJournal(secondary,{operation:'workflow-ready'}),false);
  assert.throws(()=>mainJournal(secondary,{operation:'workflow-claim',kind:'creation'}),/Primary/);
  assert.equal(mainJournal({...secondary,sender:{__codexMobilePrimary:true}},{operation:'workflow-ready'}),true);
});
test('invalid models, removed projects and path injection cannot reach native creation',async t=>{
  const {api,state,request}=fixture(t);
  assert.equal((await desktopOperation(api,'mobile-desktop-create',{...request,model:'gone'})).status,'invalid');
  assert.equal((await desktopOperation(api,'mobile-desktop-create',{...request,target:{type:'project',projectId:'gone'}})).status,'invalid');
  await assert.rejects(desktopOperation(api,'mobile-desktop-create',{...request,target:{type:'projectless',cwd:'C:/'}}),/Invalid/);
  await assert.rejects(desktopOperation(api,'mobile-desktop-create',{...request,hostId:'remote'}),/Local/);
  assert.equal(state.creates,0);
});
test('workflow receipts survive reopen and prohibit changing final thread identity',t=>{
  const {request}=fixture(t);const receipt={digest:'a'.repeat(64),status:'uncertain'};
  const claim={operation:'workflow-claim',kind:'creation',requestId:request.requestId,receipt};
  assert.equal(globalThis.codexMobileLabJournal(claim).claimed,true);
  assert.equal(globalThis.codexMobileLabJournal(claim).claimed,false);
  const final={...receipt,status:'created',threadId:randomUUID()};
  globalThis.codexMobileLabJournal({...claim,operation:'workflow-set',receipt:final});
  assert.throws(()=>globalThis.codexMobileLabJournal({...claim,operation:'workflow-set',receipt:{...final,threadId:randomUUID()}}),/immutable/);
});
test('model catalog paginates, filters hidden models and validates real effort pairs',async()=>{
  let calls=0;const models=await modelCatalog(async(_m,p)=>{calls++;return p.cursor?{data:[{...catalog[0],hidden:true}]}:{data:catalog,nextCursor:'next'};});
  assert.equal(calls,2);assert.equal(models.length,1);
  validateSelection(models,'model-a','high');validateSelection(models,null,null,true);
  assert.throws(()=>validateSelection(models,'model-a','ultra'),/unavailable/);
  assert.equal(selectionForModel(models,'model-a','ultra').effort,'low');
});
test('actual active turn and next settings are projected separately without private instructions',()=>{
  const state={latestModel:'new',latestReasoningEffort:'high',mobileSettingsEpoch:'epoch',mobileSettingsRevision:4,
    turnHistory:{kind:'canonical',history:{entitiesByKey:{t:{turnId:'turn',status:'inProgress',params:{collaborationMode:{mode:'plan',settings:{model:'old',reasoning_effort:'low',developer_instructions:'private'}}}}}}}};
  const view=settingsView(state);
  assert.equal(view.current.model,'old');assert.equal(view.next.model,'new');assert(!JSON.stringify(view).includes('private'));
  assert.equal(newestSettings({...view,version:'epoch:3'},view),view);
  assert.equal(newestSettings({...view,version:'new-epoch:1'},view).version,'new-epoch:1');
});
