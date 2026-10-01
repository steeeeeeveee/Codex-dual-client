"""Create one named acceptance chat beside existing history; never resume an existing user chat."""
import asyncio
import datetime
import json
import os
from pathlib import Path
import subprocess

ROOT=Path(__file__).resolve().parents[1]

async def main():
    target=ROOT/'runtime/shared-live-acceptance.json'
    if target.exists():
        print(target.read_text(encoding='utf-8'));return
    pointer=json.loads((ROOT/'runtime/shared-desktop.json').read_text(encoding='utf-8'))
    m=json.loads(Path(pointer['manifest']).read_text(encoding='utf-8'))
    workspace=ROOT/'runtime/shared-live-acceptance-workspace';workspace.mkdir(exist_ok=True)
    env={k:v for k,v in os.environ.items() if not k.startswith('CODEX_')}
    env.update(CODEX_HOME=m['codexHome'],HTTPS_PROXY='http://127.0.0.1:7897',HTTP_PROXY='http://127.0.0.1:7897',NO_PROXY='127.0.0.1,localhost')
    proc=await asyncio.create_subprocess_exec(str(Path(m['executable']).parent/'resources/codex.exe'),'app-server','--stdio',
        stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.DEVNULL,env=env,
        creationflags=subprocess.CREATE_NO_WINDOW,limit=32*1024*1024)
    seq=0
    async def call(method,params):
        nonlocal seq
        seq+=1;proc.stdin.write((json.dumps({'id':seq,'method':method,'params':params})+'\n').encode());await proc.stdin.drain()
        while True:
            msg=json.loads(await asyncio.wait_for(proc.stdout.readline(),45))
            if msg.get('id')==seq and 'method' not in msg:
                if 'error' in msg:raise RuntimeError(msg['error']['message'])
                return msg['result']
    try:
        await call('initialize',{'clientInfo':{'name':'codex_mobile_live_acceptance','version':'0.3.0'},'capabilities':{'experimentalApi':True}})
        proc.stdin.write(b'{"method":"initialized"}\n');await proc.stdin.drain()
        t=await call('thread/start',{'cwd':str(workspace),'model':'gpt-6-sol','approvalPolicy':'untrusted','sandbox':'read-only'})
        tid=t['thread']['id']
        await call('thread/name/set',{'threadId':tid,'name':'双端共用上线验收'})
        data={'threadId':tid,'workspace':str(workspace),'createdAt':datetime.datetime.now(datetime.timezone.utc).isoformat()}
        target.write_text(json.dumps(data,ensure_ascii=False,indent=2),encoding='utf-8')
        await call('turn/start',{'threadId':tid,'input':[{'type':'text','text':'这是独立的双端共用上线验收对话，只用于验证连接和审批。不要读取其他项目，不调用工具，现在只回复：双端连接准备就绪。'}]})
        while True:
            msg=json.loads(await asyncio.wait_for(proc.stdout.readline(),90))
            if msg.get('method')=='turn/completed':
                assert msg['params']['turn']['status']=='completed';break
        print(json.dumps(data,ensure_ascii=True))
    finally:
        proc.terminate();await proc.wait()

asyncio.run(main())
