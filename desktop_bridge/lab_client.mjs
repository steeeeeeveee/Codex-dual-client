import { randomUUID } from 'node:crypto';
import { ReadOnlyDesktopClient, encodeFrame, FrameDecoder } from './read_only_client.mjs';

export const LAB_PIPE = '\\\\.\\pipe\\codex-mobile-isolated-lab';
export class LabClient extends ReadOnlyDesktopClient {
  constructor() { super({ pipe: LAB_PIPE }); this.decoder=new FrameDecoder(256*1024*1024); }
  request(method, params, targetClientId) {
    const globals = ['mobile-desktop-usage','mobile-desktop-capabilities','mobile-desktop-create','mobile-desktop-creation-status'];
    if (!['thread-follower-mobile-lab-append', 'thread-follower-mobile-lab-control', 'thread-follower-mobile-lab-state', 'thread-follower-mobile-lab-answer', 'thread-follower-mobile-lab-settings',...globals].includes(method))
      return super.request(method, params, targetClientId);
    if (this.pipe !== LAB_PIPE || !this.socket?.writable || (!targetClientId && !globals.includes(method)))
      throw Error('Explicit isolated desktop owner required');
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(Error('Lab result unknown')); }, 15000);
      this.pending.set(requestId, { resolve, reject, timer });
      this.socket.write(encodeFrame({ type: 'request', requestId, method, params,
        sourceClientId: this.clientId, targetClientId, version: 1, timeoutMs: 14000 }));
    });
  }
}
