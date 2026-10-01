// Narrow stdio adapter. Never exposes lab controls or arbitrary desktop RPCs.
import readline from 'node:readline';
import { LabClient } from './lab_client.mjs';
import { SharedDesktopClient } from './shared_client.mjs';
import { originalDesktopStatus } from './connection_probe.mjs';
import { TranscriptStream } from './transcript_stream.mjs';
import {localizeImages,projectMedia} from './media_transport.mjs';
const production = process.argv.includes('--shared');
let client;
const following = new Map();
const streams = new Map();
const output = value => process.stdout.write(JSON.stringify(localizeImages(value))+'\n');
function subscribe(tid, owner) {
  following.set(tid, owner);
  streams.set(tid, {reducer:new TranscriptStream(tid, owner,{projectMedia}), touched:Date.now()});
  client.follow(tid, owner);
}
function broadcast(message) {
  const tid = message.params?.conversationId, entry = streams.get(tid);
  if (!entry) return;
  try {
    const transcript = entry.reducer.accept(message);
    if (transcript) {
      const publicKey = JSON.stringify([transcript.nickname, transcript.turns,transcript.settings]);
      if (publicKey === entry.publicKey) return;
      entry.publicKey = publicKey;
      entry.latest = transcript;
      if (!entry.timer) entry.timer = setTimeout(() => {
        entry.timer = null;
        if (streams.get(tid) === entry) output({event:'transcript', threadId:tid, connected:true, ...entry.latest});
      }, 60);
    }
  } catch {
    if (entry.timer) clearTimeout(entry.timer);
    output({event:'transcript', threadId:tid, connected:false});
    // A fresh following subscription requests a native snapshot, without
    // reading or changing history files. Stay paused until that baseline arrives.
    client.follow(tid, entry.reducer.owner, false);
    streams.delete(tid); following.delete(tid);
  }
}
const prune = setInterval(() => {
  for (const [tid, entry] of streams) if (Date.now() - entry.touched > 60000) {
    if (client?.socket?.writable) client.follow(tid, entry.reducer.owner, false);
    if (entry.timer) clearTimeout(entry.timer);
    streams.delete(tid); following.delete(tid);
    output({event:'transcript', threadId:tid, connected:false});
  }
}, 15000);
prune.unref();
async function call(request) {
  if (!['usage','snapshot', 'append', 'answer','capabilities','create','creation-status','settings','settings-status','implement-plan','implementation-status','pause-turn','resume-turn'].includes(request.operation)) throw Error('Unsupported mobile operation');
  if (!client?.socket?.writable) {
    client?.close(); following.clear(); streams.clear(); client = production ? new SharedDesktopClient() : new LabClient();
    const connectedClient = client;
    client.onBroadcast = message => { if (client === connectedClient) broadcast(message); };
    client.onDisconnect = () => {
      if (client !== connectedClient) return;
      for (const [tid, entry] of streams) {
        if (entry.timer) clearTimeout(entry.timer);
        output({event:'transcript', threadId:tid, connected:false});
      }
      streams.clear(); following.clear();
    };
    try { await client.connect(); }
    catch (error) {error.notSubmitted=true;throw error;}
  }
  const desktopMethod = {usage:'mobile-desktop-usage',capabilities:'mobile-desktop-capabilities',create:'mobile-desktop-create','creation-status':'mobile-desktop-creation-status'}[request.operation];
  if (desktopMethod) {
    try {return (await client.request(desktopMethod,{...request,hostId:'local'})).result;}
    catch (error) {if(error.message==='no-client-found')error.notSubmitted=true;throw error;}
  }
  const owner = await client.findOwner(request.threadId);
  if (!owner) throw Error('Desktop owner unavailable');
  if (following.get(request.threadId) !== owner) {
    if (following.has(request.threadId)) client.follow(request.threadId,following.get(request.threadId),false);
    subscribe(request.threadId,owner);
  }
  streams.get(request.threadId).touched = Date.now();
  let method = {snapshot:'thread-follower-mobile-lab-state', append:'thread-follower-mobile-lab-append', answer:'thread-follower-mobile-lab-answer',settings:'thread-follower-mobile-lab-settings','settings-status':'thread-follower-mobile-lab-settings','implement-plan':'thread-follower-mobile-lab-settings','implementation-status':'thread-follower-mobile-lab-settings'}[request.operation];
  if(['pause-turn','resume-turn'].includes(request.operation))method='thread-follower-mobile-lab-settings';
  if (production) method=method.replace('mobile-lab-','mobile-');
  const response = await client.request(method, {...request, conversationId:request.threadId, hostId:'local'}, owner);
  return response.result;
}
for await (const line of readline.createInterface({input:process.stdin})) {
  let request;
  try {
    request = JSON.parse(line);
    let result;
    try { result = await call(request); }
    catch (error) {
      if (production && request.operation === 'snapshot' && /owner unavailable|not resumed|ENOENT|ECONNREFUSED/.test(error.message)) {
        const original=await originalDesktopStatus(request.threadId);
        if (original.ownsThread) throw Error('Original desktop owns conversation');
        if (original.running) throw Error('Original desktop running; compatible owner unavailable');
      }
      throw error;
    }
    output({id:request.id, result});
  } catch (error) {
    client?.close(); client = null;
    process.stdout.write(JSON.stringify({id:request?.id, error:String(error.message),notSubmitted:error.notSubmitted===true})+'\n');
  }
}
client?.close();
