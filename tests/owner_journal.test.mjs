import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createJournal } = require('../desktop_bridge/owner_journal.cjs');
const threadId = '01a0e123-292f-7a81-917d-d0614e8019ef';
function directory(t) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-mobile-journal-'));
  t.after(() => {
    assert.equal(path.dirname(folder), path.resolve(os.tmpdir()));
    assert.ok(path.basename(folder).startsWith('codex-mobile-journal-'));
    fs.rmSync(folder, { recursive: true });
  });
  return folder;
}
test('confirmed receipt survives immediate process exit and reopening', t => {
  const folder = directory(t), messageId = randomUUID();
  const script = `const {createJournal}=require(process.argv[1]);const j=createJournal(process.argv[2],process.argv[3]);j({operation:'set',threadId:process.argv[3],messageId:process.argv[4],receipt:{digest:'a'.repeat(64),status:'committed'}});process.exit(37);`;
  const child = spawnSync(process.execPath, ['-e', script, require.resolve('../desktop_bridge/owner_journal.cjs'), folder, threadId, messageId]);
  assert.equal(child.status, 37);
  const receipt = createJournal(folder, threadId)({ operation: 'get', threadId, messageId });
  assert.deepEqual(receipt, { digest: 'a'.repeat(64), status: 'committed' });
});
test('journal rejects changed payload, backward status and path traversal', t => {
  const journal = createJournal(directory(t), threadId), messageId = randomUUID();
  const put = receipt => journal({ operation: 'set', threadId, messageId, receipt });
  put({ digest: 'a'.repeat(64), status: 'uncertain' });
  put({ digest: 'a'.repeat(64), status: 'committed' });
  assert.throws(() => put({ digest: 'b'.repeat(64), status: 'committed' }), /changed/);
  assert.throws(() => put({ digest: 'a'.repeat(64), status: 'uncertain' }), /backwards/);
  assert.throws(() => journal({ operation: 'get', threadId, messageId: '../escape' }), /Invalid/);
  assert.throws(() => journal({ operation: 'list', threadId: randomUUID() }), /Lab conversation/);
});

test('deployed journal separates chats with the same message ID and rejects invalid paths', t=>{
  const journal=createJournal(directory(t),'*'), other=randomUUID(), messageId=randomUUID();
  for(const [id,digest] of [[threadId,'a'],[other,'b']])journal({operation:'set',threadId:id,messageId,receipt:{digest:digest.repeat(64),status:'committed'}});
  assert.equal(journal({operation:'get',threadId,messageId}).digest,'a'.repeat(64));
  assert.equal(journal({operation:'get',threadId:other,messageId}).digest,'b'.repeat(64));
  assert.equal(journal({operation:'list',threadId}).length,1);
  assert.throws(()=>journal({operation:'list',threadId:'../'+other}),/conversation required/);
});

test('native image validation confines real paths and verifies immutable content',async t=>{
  const root=directory(t),id=randomUUID(),folder=path.join(root,id),file=path.join(folder,'original.png');fs.mkdirSync(folder);fs.writeFileSync(file,'image bytes');
  const prior=process.env.CODEX_MOBILE_MEDIA_ROOT;process.env.CODEX_MOBILE_MEDIA_ROOT=root;t.after(()=>{if(prior===undefined)delete process.env.CODEX_MOBILE_MEDIA_ROOT;else process.env.CODEX_MOBILE_MEDIA_ROOT=prior;});
  const journal=createJournal(root,'*'),image={id,localPath:file,sha256:createHash('sha256').update('image bytes').digest('hex'),filename:'a.png'};
  const validate=attachments=>journal({operation:'media-validate',attachments});
  assert.equal((await validate([image]))[0].localPath,fs.realpathSync(file));
  await assert.rejects(validate([{...image,id:randomUUID()}]),/outside/);
  await assert.rejects(validate([{...image,localPath:path.join(root,'media.sqlite')}]),/ENOENT|outside/);
  await assert.rejects(validate([{...image,sha256:'0'.repeat(64)}]),/changed/);
  await assert.rejects(validate(Array(11).fill(image)),/unavailable/);
});

test('native video validation rejects type spoofing, changed bytes and paths outside storage',async t=>{
  const root=directory(t),id=randomUUID(),folder=path.join(root,id),file=path.join(folder,'original.mov');fs.mkdirSync(folder);fs.writeFileSync(file,'video bytes');
  const prior=process.env.CODEX_MOBILE_MEDIA_ROOT;process.env.CODEX_MOBILE_MEDIA_ROOT=root;t.after(()=>{if(prior===undefined)delete process.env.CODEX_MOBILE_MEDIA_ROOT;else process.env.CODEX_MOBILE_MEDIA_ROOT=prior;});
  const journal=createJournal(root,'*'),video={id,kind:'video',mime:'video/quicktime',localPath:file,sha256:createHash('sha256').update('video bytes').digest('hex'),filename:'录屏.mov'};
  const validate=value=>journal({operation:'media-validate',attachments:[value]});
  assert.deepEqual((await validate(video))[0],{...video,localPath:fs.realpathSync(file)});
  await assert.rejects(validate({...video,kind:'image'}),/outside/);
  await assert.rejects(validate({...video,mime:'text/html'}),/outside/);
  await assert.rejects(validate({...video,id:randomUUID()}),/outside/);
  await assert.rejects(validate({...video,sha256:'0'.repeat(64)}),/changed/);
});
