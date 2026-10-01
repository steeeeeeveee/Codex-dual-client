import {randomUUID} from 'node:crypto';
import {ReadOnlyDesktopClient, encodeFrame, FrameDecoder} from './read_only_client.mjs';
export const SHARED_PIPE = '\\\\.\\pipe\\codex-mobile-shared-desktop';
const globals = new Set(['mobile-desktop-usage','mobile-desktop-capabilities','mobile-desktop-create','mobile-desktop-creation-status']);
const writes = new Set(['thread-follower-mobile-append','thread-follower-mobile-state','thread-follower-mobile-answer','thread-follower-mobile-settings',...globals]);
export class SharedDesktopClient extends ReadOnlyDesktopClient {
  // Match the pinned desktop's 256 MiB private IPC limit for multi-image input.
  // Public web state still contains only media references, never these bytes.
  constructor() { super({pipe:SHARED_PIPE}); this.decoder=new FrameDecoder(256*1024*1024); }
  request(method, params, targetClientId) {
    if (!writes.has(method)) return super.request(method,params,targetClientId);
    if (this.pipe !== SHARED_PIPE || !this.socket?.writable || (!targetClientId && !globals.has(method))) throw Error('Verified desktop owner required');
    const requestId=randomUUID();
    return new Promise((resolve,reject) => {
      const timer=setTimeout(()=>{this.pending.delete(requestId);reject(Error('Desktop result unknown'));},15000);
      this.pending.set(requestId,{resolve,reject,timer});
      this.socket.write(encodeFrame({type:'request',requestId,method,params,sourceClientId:this.clientId,targetClientId,version:1,timeoutMs:14000}));
    });
  }
}
