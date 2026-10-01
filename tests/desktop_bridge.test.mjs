import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameDecoder, ReadOnlyDesktopClient, encodeFrame } from '../desktop_bridge/read_only_client.mjs';

test('frames handle bytewise Unicode and multiple coalesced messages', () => {
  const input = [{ type: 'response', text: '中文🙂' }, { type: 'broadcast', version: 11 }];
  const bytes = Buffer.concat(input.map(encodeFrame));
  const decoder = new FrameDecoder();
  const output = [];
  for (const byte of bytes) output.push(...decoder.push(Buffer.from([byte])));
  assert.deepEqual(output, input);
  assert.deepEqual(new FrameDecoder().push(bytes), input);
});

test('malformed or oversized frames are rejected before allocation', () => {
  assert.throws(() => new FrameDecoder().push(Buffer.alloc(4)), /Invalid frame/);
  const length = Buffer.alloc(4); length.writeUInt32LE(0xffffffff);
  assert.throws(() => new FrameDecoder().push(length), /Invalid frame/);
  assert.throws(() => new FrameDecoder().push(Buffer.from([1, 0, 0, 0, 120])));
});

test('queue replacement, turn start, steer and approvals cannot be sent', () => {
  const client = new ReadOnlyDesktopClient();
  let writes = 0;
  client.socket = { writable: true, write() { writes++; } };
  client.clientId = 'test-observer';
  for (const method of ['thread-follower-set-queued-follow-ups-state', 'thread-follower-start-turn',
    'thread-follower-steer-turn', 'thread-follower-submit-user-input', 'turn/start', 'tools/call']) {
    assert.throws(() => client.request(method, {}), /Write operation blocked/);
  }
  assert.equal(writes, 0);
});

test('reader never claims ownership of a discovered request', () => {
  const client = new ReadOnlyDesktopClient();
  const sent = [];
  client.socket = { write(bytes) { sent.push(...new FrameDecoder().push(bytes)); } };
  client.receive({ type: 'client-discovery-request', requestId: 'discovery-1' });
  assert.equal(sent[0].response.canHandle, false);
});

test('disconnect rejects pending reads instead of leaving them hanging', async () => {
  const client = new ReadOnlyDesktopClient();
  client.clientId = 'test-observer';
  client.socket = { writable: true, write() {} };
  const pending = client.request('thread-owner-discovery', { conversationId: 'existing' });
  client.fail(new Error('Desktop disconnected'));
  await assert.rejects(pending, /Desktop disconnected/);
  assert.equal(client.pending.size, 0);
});

test('whole-list follower replacement loses concurrent additions and revives deletions', () => {
  // Contract reproduction of the inspected callback () => followerState.
  // This does not send anything to a real desktop conversation.
  const replaceFromFollower = followerState => _latestOwnerState => followerState;
  const phoneSnapshot = [{ id: 'A' }, { id: 'phone-P' }];
  const desktopAfterAppend = [{ id: 'A' }, { id: 'desktop-B' }];
  assert.deepEqual(replaceFromFollower(phoneSnapshot)(desktopAfterAppend), phoneSnapshot);
  assert.equal(replaceFromFollower(phoneSnapshot)(desktopAfterAppend).some(m => m.id === 'desktop-B'), false);
  assert.equal(replaceFromFollower(phoneSnapshot)([]).some(m => m.id === 'A'), true);
});
