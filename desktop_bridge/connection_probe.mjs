import {ReadOnlyDesktopClient} from './read_only_client.mjs';

// Diagnose the original app without claiming ownership or resuming a chat.
export async function originalDesktopStatus(threadId, createClient=()=>new ReadOnlyDesktopClient(), timeoutMs=2000) {
  const client=createClient();
  let timer, running=false;
  try {
    return await Promise.race([
      (async()=>{await client.connect();running=true;return {running:true,ownsThread:!!await client.findOwner(threadId)};})(),
      new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Probe timeout')),timeoutMs);}),
    ]);
  } catch { return {running,ownsThread:false}; }
  finally {clearTimeout(timer);client.close();}
}
