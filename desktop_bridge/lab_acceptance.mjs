import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { LabClient, LAB_PIPE } from './lab_client.mjs';

const manifest = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const phase = process.argv[3] ?? 'queue';
assert.equal(manifest.pipe, LAB_PIPE);
const conversationId = manifest.threadId;
const phone = new LabClient(), desktop = new LabClient();
const snapshots = [[], []];
let owner;
const dataFile = path.join(manifest.base, 'acceptance.json');
const receipt = (client, method, params) => client.request(method, { conversationId, ...params }, owner).then(r => r.result);
const control = (operation, params = {}) => receipt(desktop, 'thread-follower-mobile-lab-control', { operation, ...params });
const append = item => receipt(phone, 'thread-follower-mobile-lab-append', item);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  await Promise.all([phone.connect(), desktop.connect()]);
  owner = await phone.findOwner(conversationId);
  for (let attempt = 0; !owner && attempt < 6; attempt++) {
    await delay(3000);
    owner = await phone.findOwner(conversationId);
  }
  assert.ok(owner, 'The isolated desktop must own the test conversation');
  [phone, desktop].forEach((client, index) => {
    client.onBroadcast = m => {
      if (m.sourceClientId === owner && m.method === 'thread-queued-followups-changed'
          && m.params.conversationId === conversationId) snapshots[index] = m.params.messages.map(item => ({ ...item, id: item.clientUserMessageId ?? item.id }));
    };
    client.follow(conversationId, owner);
  });
  if (phase === 'queue') {
    let state = await control('hold');
    assert.equal(state.messages.length, 0, 'Use an empty isolated queue');
    for (let attempt = 0; state.activeTurnId && attempt < 20; attempt++) {
      await delay(1500); state = await control('inspect');
    }
    assert.equal(state.activeTurnId, null, 'Wait for the earlier smoke test');
    const blocker = { messageId: randomUUID(), text: '为了测试当前轮运行时的排队，请使用命令执行工具运行 PowerShell 的 Start-Sleep -Seconds 75。只等待，不读取或写入文件。等待完成后只回复等待结束。' };
    await append(blocker);
    state = await control('inspect');
    if (!state.activeTurnId) { await control('release'); await control('hold'); }
    for (let attempt = 0; !state.activeTurnId && attempt < 20; attempt++) {
      await delay(300); state = await control('inspect');
    }
    assert.ok(state.activeTurnId, 'The queue test requires an active turn');
    const mobile = Array.from({ length: 10 }, (_, i) => ({ messageId: randomUUID(), text: `手机队列测试 P${i + 1}：只回复 P${i + 1}，不要调用工具。` }));
    const native = Array.from({ length: 10 }, (_, i) => ({ messageId: randomUUID(), text: `电脑队列测试 D${i + 1}：只回复 D${i + 1}，不要调用工具。` }));
    await Promise.all(mobile.flatMap((item, i) => [append(item), control('native-append', native[i])]));
    const queued = await control('inspect');
    assert.equal(queued.messages.length, 20);
    assert.equal(new Set(queued.messages.map(m => m.id)).size, 20);
    await delay(500);
    for (const snapshot of snapshots) assert.deepEqual(snapshot.map(m => m.id), queued.messages.map(m => m.id));
    assert.equal((await append(mobile[0])).status, 'queued');
    await control('edit', { messageId: mobile[0].messageId, text: '桌面编辑保留测试：只回复编辑完成。' });
    await append(mobile[0]);
    assert.equal((await control('inspect')).messages.find(m => m.id === mobile[0].messageId).text, '桌面编辑保留测试：只回复编辑完成。');
    await control('remove', { messageId: mobile[0].messageId });
    assert.equal((await append(mobile[0])).status, 'accepted-earlier');
    assert.ok(!(await control('inspect')).messages.some(m => m.id === mobile[0].messageId));
    const order = (await control('inspect')).messages.map(m => m.id).reverse();
    await control('reorder', { order });
    assert.deepEqual((await control('inspect')).messages.map(m => m.id), order);
    await delay(300);
    for (const snapshot of snapshots) assert.deepEqual(snapshot.map(m => m.id), order);
    const keep = [mobile[1].messageId, native[1].messageId];
    for (const id of order) if (!keep.includes(id)) await control('remove', { messageId: id });
    await control('reorder', { order: keep });
    await control('pause-all');
    const beforeShutdown = await control('inspect');
    assert.deepEqual(beforeShutdown.messages.map(m => m.id), keep, 'Both pending messages must still be queued at shutdown');
    const result = { conversationId, phase: 'queue', concurrentMessages: 20, queueMirrorsMatch: true,
      retryDeduplicated: true, desktopEditPreserved: true, desktopDeletePreserved: true,
      desktopReorderMirrored: true, remaining: keep, mobile, native, blockerId: blocker.messageId,
      pendingAtShutdown: beforeShutdown.messages.map(m => m.id), shutdownRequestedAt: new Date().toISOString() };
    if (fs.existsSync(dataFile)) fs.copyFileSync(dataFile, path.join(manifest.base, 'acceptance-previous-' + Date.now() + '.json'));
    fs.writeFileSync(dataFile, JSON.stringify(result, null, 2));
    // Stop from the test itself, avoiding model/tool round-trip delays that
    // could let the pending messages finish before the restart experiment.
    fs.writeFileSync(path.join(manifest.base, 'stop-lab'), 'restart acceptance');
    console.log(JSON.stringify({ ...result, mobile: undefined, native: undefined }));
  } else if (phase === 'recovery') {
    const result = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    const restored = await control('hold', { messageIds: result.remaining });
    for (const id of result.remaining) assert.ok(restored.messages.some(m => m.id === id) || restored.acceptedIds.includes(id), 'Restart must retain or execute each confirmed message');
    if (!restored.serverQueueEnabled) assert.ok(restored.messages.every(m => m.pausedReason === 'Mobile lab recovery test'));
    assert.ok(['queued', 'executed'].includes((await append(result.mobile[1])).status));
    assert.equal((await append(result.mobile[0])).status, 'accepted-earlier');
    assert.ok((await control('inspect')).messages.length <= 2);
    result.desktopRestartRetainedQueue = true;
    result.desktopRestartRetainedReceipts = true;
    await control('unpause-all');
    await control('release');
    let state;
    const deadline = Date.now() + 120000;
    do {
      state = await control('inspect', { messageIds: result.remaining });
      if (state.messages.length === 0 && state.activeTurnId === null && state.acceptedIds.length >= 2) break;
      await delay(1500);
    } while (Date.now() < deadline);
    result.execution = { queueCount: state.messages.length, activeTurnId: state.activeTurnId,
      acceptedIds: state.acceptedIds, pausedReasons: state.messages.map(m => m.pausedReason ?? null) };
    result.executedBoth = result.remaining.every(id => state.acceptedIds.includes(id)) && state.messages.length === 0;
    const sessionRoot = path.join(manifest.codexHome, 'sessions');
    const files = fs.readdirSync(sessionRoot, { recursive: true }).filter(file => file.endsWith(result.conversationId + '.jsonl'));
    assert.equal(files.length, 1);
    const userItems = fs.readFileSync(path.join(sessionRoot, files[0]), 'utf8').split('\n').filter(Boolean)
      .map(line => JSON.parse(line)).filter(row => row.type === 'event_msg' && row.payload.type === 'item_completed'
        && row.payload.item?.type === 'UserMessage').map(row => row.payload.item.client_id);
    result.executionOrder = userItems.filter(id => result.remaining.includes(id));
    result.exactlyOnceInHistory = JSON.stringify(result.executionOrder) === JSON.stringify(result.remaining);
    result.deletedMessageNotExecuted = !userItems.includes(result.mobile[0].messageId);
    fs.writeFileSync(dataFile, JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ ...result, mobile: undefined, native: undefined }));
    assert.ok(result.executedBoth, 'Native queued execution has not completed');
    assert.ok(result.exactlyOnceInHistory, 'Every kept message must execute once, in native queue order');
    assert.ok(result.deletedMessageNotExecuted, 'Deleted message must not reappear after restart');
  } else throw Error('Unknown phase');
} finally { phone.close(); desktop.close(); }
