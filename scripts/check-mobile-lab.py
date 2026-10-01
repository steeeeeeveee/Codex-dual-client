"""Real HTTP -> durable outbox -> desktop acceptance, using only the lab chat."""
import concurrent.futures
import json
from pathlib import Path
import sys
import time
import uuid
import httpx

manifest=json.loads(Path(sys.argv[1]).read_text())
phase=sys.argv[2]
base=Path(manifest['base'])
tid=manifest['threadId']
evidence=base/'mobile-acceptance.json'
c=httpx.Client(base_url='http://127.0.0.1:8768',headers={'Origin':'http://127.0.0.1:8768','X-Mobile-Client':'1'},timeout=30)
c.post('/api/login',json={'password':'phone-queue-ui-test'}).raise_for_status()
def state():
    r=c.get('/api/state',params={'threadId':tid});r.raise_for_status();return r.json()
def post(body):
    r=c.post('/api/send',json=body);r.raise_for_status();return r.json()
def until(predicate, timeout=60):
    end=time.monotonic()+timeout
    while time.monotonic()<end:
        s=state()
        if predicate(s):return s
        time.sleep(1)
    raise AssertionError('Acceptance condition timed out')

if phase=='connected':
    until(lambda s:s['desktop']['connected'])
    messages=[dict(id=str(uuid.uuid4()),threadId=tid,text=f'手机 HTTP 验收 M{i+1}：仅回复 M{i+1}。不要调用工具。') for i in range(3)]
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        results=list(pool.map(post,messages))
    assert all(r['status']=='waiting' for r in results)
    post(messages[0])
    ids={m['id'] for m in messages}
    s=until(lambda s:all(r['status'] in ('executed','accepted-earlier') for r in s['outbox'] if r['id'] in ids) and not s['turnId'])
    text=[v['text'] for t in s['thread']['turns'] for item in t['items'] if item['type']=='userMessage' for v in item.get('content',[]) if v['type']=='text']
    assert all(sum(m['text'] in t for t in text)==1 for m in messages)
    saved_order=[r['id'] for r in s['outbox'] if r['id'] in ids]
    execution_order=[m['id'] for t in text for m in messages if m['text'] in t]
    assert execution_order==saved_order
    evidence.write_text(json.dumps({'connected':True,'messages':messages,'duplicateRetryExactlyOnce':True},ensure_ascii=False,indent=2),encoding='utf-8')
    print('PASS: concurrent HTTP submissions and same-ID retry executed exactly once')
elif phase=='offline':
    until(lambda s:not s['desktop']['connected'])
    messages=[dict(id=str(uuid.uuid4()),threadId=tid,text=f'手机恢复验收 R{i+1}：仅回复 R{i+1}。不要调用工具。') for i in range(3)]
    for m in messages:assert post(m)['status']=='waiting'
    c.post('/api/queue/cancel',json={'threadId':tid,'messageId':messages[1]['id']}).raise_for_status()
    s=state();statuses={r['id']:r['status'] for r in s['outbox']}
    assert [statuses[m['id']] for m in messages]==['waiting','cancelled','waiting']
    data=json.loads(evidence.read_text(encoding='utf-8'));data['offlineMessages']=messages
    evidence.write_text(json.dumps(data,ensure_ascii=False,indent=2),encoding='utf-8')
    print('PASS: offline messages saved, middle message cancelled')
elif phase=='recovery':
    data=json.loads(evidence.read_text(encoding='utf-8'));messages=data['offlineMessages'];ids={m['id'] for m in messages}
    s=until(lambda s:s['desktop']['connected'] and not s['turnId'] and all(r['status'] in ('executed','accepted-earlier','cancelled') for r in s['outbox'] if r['id'] in ids))
    text=[v['text'] for t in s['thread']['turns'] for item in t['items'] if item['type']=='userMessage' for v in item.get('content',[]) if v['type']=='text']
    assert [sum(m['text'] in t for t in text) for m in messages]==[1,0,1]
    assert next(i for i,t in enumerate(text) if messages[0]['text'] in t)<next(i for i,t in enumerate(text) if messages[2]['text'] in t)
    data['recoveryExactlyOnceInOrder']=True
    evidence.write_text(json.dumps(data,ensure_ascii=False,indent=2),encoding='utf-8')
    print('PASS: desktop and mobile-service restart preserved order without duplicate or cancelled execution')
else:raise ValueError('Unknown phase')
