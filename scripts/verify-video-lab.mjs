// Only the separate, disposable desktop pipe. Never submit to a user chat.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {LabClient} from '../desktop_bridge/lab_client.mjs';
const manifest=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
assert.equal(path.basename(path.dirname(manifest.base)),'desktop-prototype');
const asset=JSON.parse(fs.readFileSync(process.argv[3],'utf8'));
const client=new LabClient(),tid=manifest.threadId;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let owner,held=false,mid;
const request=(method,params)=>client.request(method,{conversationId:tid,...params},owner).then(result=>result.result);
const control=operation=>request('thread-follower-mobile-lab-control',{operation,messageId:mid});
try{
 await client.connect();
 for(let i=0;i<15&&!owner;i++){owner=await client.findOwner(tid);if(!owner)await delay(2000);}
 assert.ok(owner,'isolated owner required');
 const before=await control('inspect');assert.equal(before.activeTurnId,null);assert.equal(before.messages.length,0);
 await control('hold');held=true;
 mid=randomUUID();const input={messageId:mid,text:'这是视频附件传输验收。不要读取文件或调用工具，只回复：视频附件已收到。',attachments:[asset]};
 const first=await request('thread-follower-mobile-lab-append',input);
 const again=await request('thread-follower-mobile-lab-append',input);
 assert.equal(first.messageId,mid);assert.ok(['queued','executed','accepted-earlier'].includes(again.status));
 const state=await control('inspect');
 const item=state.messages.find(item=>(item.clientUserMessageId??item.id)===mid);
 if(item){assert.equal(item.context.imageAttachments.length,0);assert.equal(item.context.fileAttachments[0].path,asset.localPath);await control('remove');}
 await control('release');held=false;
 let snapshot;
 for(let i=0;i<30;i++){
  snapshot=await request('thread-follower-mobile-lab-state',{});
  if(!snapshot.turnId)break;await delay(1000);
 }
 const nativeText=(snapshot.thread?.turns??[]).flatMap(turn=>turn.items??[]).filter(item=>item.type==='userMessage').flatMap(item=>item.content??[]).filter(part=>part.type==='text').map(part=>part.text).join('\n');
 assert.ok(item||nativeText.includes(asset.localPath),'video must reach native queue or executed native input');
 const report={nativeQueueAccepted:true,videoOnlyFileAttachment:true,retryStatus:again.status,removedTestQueueItem:!!item,nativeInputContainsFile:nativeText.includes(asset.localPath),activeTurn:snapshot.turnId??null};
 fs.writeFileSync(path.join(path.dirname(process.argv[3]),'native-result.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify(report));
}finally{if(held)await control('release').catch(()=>{});client.close();}
