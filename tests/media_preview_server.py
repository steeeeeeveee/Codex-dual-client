"""Isolated real upload/storage UI; execution is simulated, never a live thread."""
import io
import json
import os
from pathlib import Path
import sys
import uuid

ROOT=Path(__file__).resolve().parents[1]
BASE=ROOT/'runtime/media-preview'
BASE.mkdir(parents=True,exist_ok=True)
configuration=json.loads((ROOT/'runtime/config.json').read_text(encoding='utf-8'))
tid='5a2e7ff7-a82e-4203-a05a-fad7d0924dab'
cfg={'password':'image-preview','origins':['http://127.0.0.1:8774'],'codex':configuration['codex'],
     'sharedOnly':True,'sharedLab':{'node':configuration['sharedDesktop']['node'],'threads':{tid:'图片功能 · 隔离预览'}}}
(BASE/'config.json').write_text(json.dumps(cfg),encoding='utf-8')
os.environ.update(MOBILE_CONFIG=str(BASE/'config.json'),MOBILE_DB=str(BASE/'deliveries.sqlite'),MOBILE_MEDIA_ROOT=str(BASE/'images'))
sys.path.insert(0,str(ROOT))
import app
from PIL import Image,ImageDraw,ImageFont
from fastapi.responses import HTMLResponse
from scripts.windows_job import contain_process_tree

contain_process_tree()
image=Image.new('RGB',(760,440),'#f5f5fb');draw=ImageDraw.Draw(image);draw.ellipse((45,80,215,250),fill='#e04949');draw.rectangle((285,80,455,250),fill='#4882df');draw.polygon([(575,80),(500,250),(690,250)],fill='#51a270');draw.text((42,300),'CODEX 7319',font=ImageFont.truetype('C:/Windows/Fonts/arial.ttf',50),fill='#202124');data=io.BytesIO();image.save(data,format='PNG')
(BASE/'sample.png').write_bytes(data.getvalue());image.save(BASE/'sample.heic',format='HEIF')
asset=app.media.ingest(data.getvalue(),'17b10d78-c61e-4886-9110-f9bfa7534d96','sample.png')
thread={'id':tid,'name':'图片功能 · 隔离预览','turns':[{'id':'preview','status':'completed','items':[
    {'id':'user','type':'userMessage','content':[{'type':'text','text':'看看这张图片。'},{'type':'localImage','path':asset['path']}]},
    {'id':'reply','type':'agentMessage','text':'**图片现在可以直接显示。**\n\n![图片预览](<'+asset['path']+'>)\n\n保持原始比例，点击图片可放大查看。'},
    {'id':'generated','type':'imageGeneration','savedPath':asset['path'],'status':'completed'}]}]}
settings={'version':'preview:1','next':{'model':'preview','effort':'medium','mode':'default'},'current':None}
receipts=[];queue=[]
async def call(operation,thread_id,**params):
    if operation=='capabilities':return {'protocol':'mobile-compose-v1','desktop':{'connected':True},'models':[{'id':'preview','name':'GPT-6 Sol','defaultEffort':'medium','efforts':[{'id':'medium'},{'id':'high'}]}],'projects':[],'defaults':{'inherit':True},'create':True,'settings':True,'planMode':True,'usage':False,'imageInputs':True,'imageOutputs':True}
    if operation=='snapshot':return {'protocol':'mobile-queue-v2','threadId':tid,'thread':thread,'queue':queue,'receipts':receipts,'pending':[],'turnId':None,'planMode':True,'imageInputs':True,'settings':settings}
    if operation=='append':
        receipts.append({'messageId':params['messageId'],'status':'executed'})
        thread['turns'].append({'id':str(uuid.uuid4()),'status':'completed','items':[{'id':params['messageId'],'type':'userMessage','content':[{'type':'text','text':params['text']}]+[{'type':'localImage','path':a['localPath']} for a in params.get('attachments',[])]},{'id':str(uuid.uuid4()),'type':'agentMessage','text':'隔离预览已接收图片；此页面不启动模型。'}]})
        return {'messageId':params['messageId'],'status':'executed'}
    raise RuntimeError('Preview does not execute this operation')
app.shared.adapter.call=call
app.shared.db.execute('INSERT OR REPLACE INTO mobile_snapshots VALUES(?,?)',(tid,json.dumps({'thread':thread,'settings':settings,'imageInputs':True,'planMode':True})));app.shared.db.commit()
app.usage.get=lambda refresh=False: unavailable()
async def unavailable():return {'status':'unavailable','windows':{}}
@app.app.get('/preview/chat')
async def preview():
    html=(ROOT/'static/index.html').read_text(encoding='utf-8').replace('<script type="module" src="/static/app.js','<script src="/preview/seed.js"></script><script type="module" src="/static/app.js')
    return HTMLResponse(html)
@app.app.get('/preview/seed.js')
async def seed():
    from fastapi.responses import Response
    return Response('sessionStorage.setItem("selectedThread",'+json.dumps(tid)+');sessionStorage.removeItem("newConversation");',media_type='application/javascript')
import uvicorn
uvicorn.run(app.app,host='127.0.0.1',port=8774,access_log=False)
