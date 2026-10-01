"""Exercise the deployed owner module in two explicitly isolated acceptance chats."""
import asyncio
import json
from pathlib import Path
import sys
import uuid

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from shared_queue import DesktopAdapter

async def main():
    first=json.loads((ROOT/'runtime/desktop-prototype/full-1466976c61f6/manifest.json').read_text())
    second=json.loads((ROOT/'runtime/desktop-prototype/multi-chat/manifest.json').read_text())
    ids=[first['threadId'],second['threadId']]
    adapter=DesktopAdapter(str(Path(first['sourceInstallation'])/'app/resources/cua_node/bin/node.exe'),ROOT,True)
    async def state(tid):return await adapter.call('snapshot',tid)
    async def wait(predicate,tid,seconds=65):
        for _ in range(seconds):
            s=await state(tid)
            if predicate(s):return s
            await asyncio.sleep(1)
        raise AssertionError('Acceptance timed out')
    async def send(tid,text):
        mid=str(uuid.uuid4());r=await adapter.call('append',tid,messageId=mid,text=text)
        assert r['messageId']==mid
        return mid
    try:
        for tid in ids:
            s=await state(tid);assert not s['turnId'] and not s['queue'] and not s['pending']
        qid=await send(ids[0],'双端多对话验收：请立刻使用内置 request_user_input 问“多对话测试选哪个？”，选项“多聊甲”“多聊乙”。等我选择后仅复述选项，不调用其他工具。')
        a=await wait(lambda s:bool(s['pending']),ids[0])
        question=a['pending'][0]
        mids=await asyncio.gather(*(send(ids[1],f'独立队列 B{i}：只回复 B{i}，不要调用工具。') for i in range(3)))
        # Reading a second chat must not erase the first chat's question token.
        b=await wait(lambda s:not s['turnId'] and not s['queue'],ids[1])
        try:
            await adapter.call('answer',ids[1],requestId=question['clientRequestId'],answers={question['params']['questions'][0]['id']:'多聊乙'})
        except RuntimeError:pass
        else:raise AssertionError('Cross-chat answer accepted')
        await adapter.call('answer',ids[0],requestId=question['clientRequestId'],answers={question['params']['questions'][0]['id']:'多聊乙'})
        # Submit as the pending turn resumes/completes. Only native queue/add is used.
        boundary=await asyncio.gather(*(send(ids[0],f'边界队列 A{i}：只回复 A{i}，不要调用工具。') for i in range(3)))
        a=await wait(lambda s:not s['turnId'] and not s['queue'] and not s['pending'],ids[0])
        for tid,s,wanted in [(ids[0],a,boundary),(ids[1],b,mids)]:
            seen=[item.get('clientId') for turn in s['thread']['turns'] for item in turn['items'] if item['type']=='userMessage']
            assert all(seen.count(mid)==1 for mid in wanted),(tid,seen,wanted)
            assert [mid for mid in seen if mid in wanted]==wanted
        result=dict(multiChat=True,crossChatAnswerRejected=True,questionSurvivedOtherChat=True,boundaryQueueExactlyOnce=True,threadIds=ids)
        (ROOT/'runtime/shared-multichat-acceptance.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
        print(json.dumps(result))
    finally:await adapter.close()

asyncio.run(main())
