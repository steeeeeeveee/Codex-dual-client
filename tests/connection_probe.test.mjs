import test from 'node:test';
import assert from 'node:assert/strict';
import {originalDesktopStatus} from '../desktop_bridge/connection_probe.mjs';

test('original desktop ownership probe only connects, discovers and closes',async()=>{
  const calls=[];
  const status=await originalDesktopStatus('test',()=>({
    async connect(){calls.push('connect');},async findOwner(tid){calls.push(tid);return 'owner';},close(){calls.push('close');}
  }));
  assert.deepEqual(status,{running:true,ownsThread:true});
  assert.deepEqual(calls,['connect','test','close']);
});
test('running original app does not prove ownership of another conversation',async()=>{
  const status=await originalDesktopStatus('test',()=>({async connect(){},async findOwner(){return null;},close(){}}));
  assert.deepEqual(status,{running:true,ownsThread:false});
});
test('unavailable or slow original app cannot indefinitely block the shared adapter',async()=>{
  let closed=0;
  const unavailable=await originalDesktopStatus('test',()=>({async connect(){throw Error('offline');},close(){closed++;}}));
  const slow=await originalDesktopStatus('test',()=>({async connect(){},findOwner(){return new Promise(()=>{});},close(){closed++;}}),10);
  assert.deepEqual(unavailable,{running:false,ownsThread:false});
  assert.deepEqual(slow,{running:true,ownsThread:false});assert.equal(closed,2);
});
