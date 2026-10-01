import net from 'node:net';
import { randomUUID } from 'node:crypto';

export const PIPE = '\\\\.\\pipe\\codex-ipc';
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const READ_REQUESTS = new Map([
  ['initialize', 0],
  ['thread-owner-discovery', 1],
  ['thread-follower-load-complete-history', 1],
]);

export function encodeFrame(message) {
  const body = Buffer.from(JSON.stringify(message));
  if (!body.length || body.length > MAX_FRAME_BYTES) throw new Error('Invalid frame length');
  const size = Buffer.alloc(4);
  size.writeUInt32LE(body.length);
  return Buffer.concat([size, body]);
}

export class FrameDecoder {
  constructor(maxFrameBytes=MAX_FRAME_BYTES){if(!Number.isSafeInteger(maxFrameBytes)||maxFrameBytes<1||maxFrameBytes>256*1024*1024)throw Error('Invalid frame limit');this.maxFrameBytes=maxFrameBytes;}
  buffer = Buffer.alloc(0);
  push(data) {
    this.buffer = Buffer.concat([this.buffer, data]);
    const frames = [];
    while (this.buffer.length >= 4) {
      const size = this.buffer.readUInt32LE();
      if (!size || size > this.maxFrameBytes) throw new Error('Invalid frame length');
      if (this.buffer.length < size + 4) break;
      frames.push(JSON.parse(this.buffer.subarray(4, size + 4).toString('utf8')));
      this.buffer = this.buffer.subarray(size + 4);
    }
    return frames;
  }
}

export class ReadOnlyDesktopClient {
  constructor({ pipe = PIPE } = {}) { this.pipe = pipe; }
  clientId = 'initializing-client';
  pending = new Map();
  decoder = new FrameDecoder();
  socket;
  following;
  onBroadcast = () => {};
  onDisconnect = () => {};

  async connect() {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.socket?.destroy(); reject(new Error('Connection timeout')); }, 5000);
      this.socket = net.createConnection(this.pipe);
      this.socket.once('connect', () => { clearTimeout(timer); resolve(); });
      this.socket.on('error', error => { clearTimeout(timer); this.fail(error); reject(error); });
      this.socket.on('close', () => this.fail(new Error('Desktop disconnected')));
      this.socket.on('data', data => {
        try { for (const message of this.decoder.push(data)) this.receive(message); }
        catch (error) { this.fail(error); this.socket.destroy(); }
      });
    });
    const response = await this.request('initialize', { clientType: 'codex-mobile-readonly' });
    if (typeof response.result?.clientId !== 'string') throw new Error('Missing desktop client identity');
    this.clientId = response.result.clientId;
  }

  request(method, params, targetClientId) {
    if (!READ_REQUESTS.has(method)) throw new Error('Write operation blocked by read-only adapter');
    if (method !== 'initialize' && this.clientId === 'initializing-client') throw new Error('Not initialized');
    if (!this.socket?.writable) throw new Error('Not connected');
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error('Desktop request timeout')); }, 10000);
      this.pending.set(requestId, { resolve, reject, timer });
      this.socket.write(encodeFrame({ type: 'request', requestId, sourceClientId: this.clientId,
        version: READ_REQUESTS.get(method), method, params, targetClientId, timeoutMs: 8000 }));
    });
  }

  receive(message) {
    if (message.type === 'response') {
      const pending = this.pending.get(message.requestId);
      if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(message.requestId);
      if (message.resultType === 'success') pending.resolve(message);
      else pending.reject(new Error(message.error || 'Desktop request failed'));
    } else if (message.type === 'client-discovery-request') {
      this.socket.write(encodeFrame({ type: 'client-discovery-response', requestId: message.requestId,
        response: { canHandle: false } }));
    } else if (message.type === 'request') {
      this.socket.write(encodeFrame({ type: 'response', requestId: message.requestId,
        resultType: 'error', error: 'Read-only observer has no mutation handlers' }));
    } else if (message.type === 'broadcast') {
      if (message.targetClientIds && !message.targetClientIds.includes(this.clientId)) return;
      this.onBroadcast(message);
    }
  }

  async findOwner(conversationId) {
    try {
      const response = await this.request('thread-owner-discovery', { hostId: 'local', conversationId });
      return response.handledByClientId ?? null;
    } catch (error) {
      if (error.message === 'no-client-found') return null;
      throw error;
    }
  }

  follow(conversationId, owner, following = true) {
    if (!this.socket?.writable || this.clientId === 'initializing-client') throw new Error('Not connected');
    if (following) this.following = { conversationId, owner };
    this.socket.write(encodeFrame({ type: 'broadcast', method: 'thread-stream-following-changed',
      version: 1, sourceClientId: this.clientId, targetClientIds: [owner],
      params: { hostId: 'local', conversationId, following } }));
    if (!following) this.following = undefined;
  }

  fail(error) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    this.onDisconnect(error);
  }

  close() {
    if (this.following && this.socket?.writable) this.follow(this.following.conversationId, this.following.owner, false);
    this.socket?.end();
    this.fail(new Error('Observer closed'));
    const timer = setTimeout(() => this.socket?.destroy(), 200);
    timer.unref();
  }
}
