"""Exercise the isolated localhost service; no production URL or credentials."""
import argparse
import http.cookiejar
import json
from pathlib import Path
import time
import urllib.request
import uuid

ROOT=Path(__file__).resolve().parents[1]
BASE='http://127.0.0.1:8769'
FILE=ROOT/'runtime/compose-recovery-acceptance.json'
parser=argparse.ArgumentParser();parser.add_argument('--prepare',action='store_true');args=parser.parse_args()
config=json.loads((ROOT/'runtime/compose-web-test.json').read_text(encoding='utf-8'))
assert config['origins']==[BASE] and 'sharedLab' in config and 'sharedDesktop' not in config
opener=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
def api(path,body=None):
    return json.load(opener.open(urllib.request.Request(BASE+'/api/'+path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={'Origin':BASE,'X-Mobile-Client':'1','Content-Type':'application/json'}),timeout=30))
api('login',{'password':config['password']})
if args.prepare:
    for _ in range(20):
        if not api('capabilities')['desktop']['connected']:break
        time.sleep(1)
    else:raise RuntimeError('Stop the isolated desktop before preparing recovery acceptance')
    request={'requestId':str(uuid.uuid4()),'messageId':str(uuid.uuid4()),'target':{'type':'projectless'},'model':'gpt-6-sol','effort':'low',
        'text':'Isolated offline restart acceptance. Do not use tools. Reply only RECOVERY_OK.'}
    first=api('threads',request);second=api('threads',request)
    assert first['requestId']==second['requestId'] and first['status']=='waiting'
    cancelled={**request,'requestId':str(uuid.uuid4()),'messageId':str(uuid.uuid4()),'text':'Cancelled before desktop handoff'}
    api('threads',cancelled);api('threads/cancel',{'requestId':cancelled['requestId']})
    if FILE.exists():FILE.with_name('compose-recovery-previous-'+uuid.uuid4().hex[:8]+'.json').write_bytes(FILE.read_bytes())
    FILE.write_text(json.dumps({'request':request,'cancelled':cancelled,'before':api('threads/requests')}),encoding='utf-8')
    print('Waiting request and cancellation saved; restart the test service and desktop now.')
else:
    evidence=json.loads(FILE.read_text(encoding='utf-8'))
    for _ in range(60):
        rows=api('threads/requests')['data'];row=next(r for r in rows if r['requestId']==evidence['request']['requestId'])
        if row['status']=='complete':break
        time.sleep(1)
    else:raise RuntimeError('Creation did not recover: '+row['status'])
    assert next(r for r in rows if r['requestId']==evidence['cancelled']['requestId'])['status']=='cancelled'
    assert api('threads',evidence['request'])['threadId']==row['threadId']
    for _ in range(45):
        state=api('state?threadId='+row['threadId'])
        turns=state['thread'].get('turns',[])
        if not state['turnId'] and turns and turns[-1]['status']=='completed':break
        time.sleep(1)
    assert len(turns)==1 and turns[0]['status']=='completed'
    assert any(i.get('text')=='RECOVERY_OK' for i in turns[0]['items'])
    evidence.update(after=row,state=state,capabilities=api('capabilities'),passed=True)
    FILE.write_text(json.dumps(evidence),encoding='utf-8')
    print(json.dumps({'passed':True,'threadId':row['threadId'],'turnCount':len(turns),'defaults':evidence['capabilities'].get('defaults')}))
