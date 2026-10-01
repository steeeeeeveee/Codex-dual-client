"""Private, loopback-only Codex client. No raw RPC endpoint is exposed."""
import asyncio
import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
import sqlite3
import subprocess
import time
from contextlib import asynccontextmanager, aclosing

from fastapi import FastAPI, HTTPException, Request, UploadFile, File, Form
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from shared_queue import DesktopAdapter, SharedQueue
from mobile_usage import UsageService
from mobile_compose import MobileComposer
from desktop_launch import request_open, latest_request, upgrade_status
from turn_routes import register_turn_routes
from media_store import MediaStore, MAX_FILE, MAX_UPLOAD, identity as media_identity

ROOT = Path(__file__).resolve().parent
RUNTIME = ROOT / 'runtime'
RUNTIME.mkdir(exist_ok=True)
CONFIG = Path(os.environ.get('MOBILE_CONFIG', str(RUNTIME / 'config.json')))
if not CONFIG.exists():
    CONFIG.write_text(json.dumps({'password': secrets.token_urlsafe(24), 'origins': ['http://127.0.0.1:8767', 'http://localhost:8767'], 'codex': r'C:\Users\steve\AppData\Local\OpenAI\Codex\bin\faa963e871dd422c\codex.exe'}, indent=2), encoding='utf-8')
cfg = json.loads(CONFIG.read_text(encoding='utf-8'))
sessions = {}
session_seen = {}
attempts = {}
DB_PATH = Path(os.environ.get('MOBILE_DB', str(RUNTIME / 'deliveries.sqlite')))
db = sqlite3.connect(DB_PATH)
db.execute('CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, digest TEXT NOT NULL, status TEXT NOT NULL, result TEXT)')
db.commit()

def audit(event, **fields):
    with (RUNTIME / 'audit.jsonl').open('a', encoding='utf-8') as f:
        f.write(json.dumps({'time': time.time(), 'event': event, **fields}, ensure_ascii=False) + '\n')

class RpcError(Exception):
    pass

class Bridge:
    def __init__(self):
        self.proc = None
        self.seq = 0
        self.futures = {}
        self.pending = {}
        self.active = None
        self.turn = None
        self.items = {}
        self.model = None
        self.reasoning = None
        self.completed_turns = set()
        self.error = None
        self.lock = asyncio.Lock()
        self.tasks = []

    async def start(self):
        if self.proc and self.proc.returncode is None:
            return
        self.error = None
        env = os.environ.copy()
        # Windows system proxy is not consistently inherited by Rust networking.
        env.setdefault('HTTPS_PROXY', 'http://127.0.0.1:7897')
        env.setdefault('HTTP_PROXY', 'http://127.0.0.1:7897')
        env['NO_PROXY'] = '127.0.0.1,localhost'
        self.proc = await asyncio.create_subprocess_exec(cfg['codex'], 'app-server', '--stdio', stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, env=env, creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0, limit=32 * 1024 * 1024)
        self.tasks = [asyncio.create_task(self.read()), asyncio.create_task(self.drain())]
        try:
            await self.call('initialize', {'clientInfo': {'name': 'codex_private_mobile', 'title': '私人手机控制', 'version': '0.1.0'}, 'capabilities': {'experimentalApi': True}})
            await self.write({'method': 'initialized'})
        except Exception:
            await self.close()
            raise

    async def drain(self):
        # Logs may contain private prompts; do not persist them.
        while await self.proc.stderr.readline():
            pass

    async def write(self, obj):
        if not self.proc or self.proc.returncode is not None:
            raise RpcError('Codex 连接已断开；请重新接管并核对历史。')
        self.proc.stdin.write((json.dumps(obj, ensure_ascii=False) + '\n').encode())
        await self.proc.stdin.drain()

    async def call(self, method, params):
        self.seq += 1
        rid = self.seq
        fut = asyncio.get_running_loop().create_future()
        self.futures[rid] = fut
        try:
            await self.write({'id': rid, 'method': method, 'params': params})
            return await asyncio.wait_for(fut, 45)
        except asyncio.TimeoutError:
            raise RpcError('Codex 响应超时；发送结果可能不确定，请先检查历史，不要重复发送。')
        finally:
            self.futures.pop(rid, None)

    async def read(self):
        try:
            while line := await self.proc.stdout.readline():
                msg = json.loads(line)
                if 'method' not in msg:
                    fut = self.futures.get(msg.get('id'))
                    if fut and not fut.done():
                        if 'error' in msg:
                            fut.set_exception(RpcError(msg['error']['message']))
                        else:
                            fut.set_result(msg.get('result', {}))
                    continue
                await self.event(msg)
        except Exception as exc:
            self.error = str(exc)
        finally:
            for fut in self.futures.values():
                if not fut.done():
                    fut.set_exception(RpcError('Codex 连接已断开；请核对历史。'))
            self.error = self.error or 'Codex 连接已断开。'
            self.pending.clear()
            self.active = None
            self.turn = None

    async def event(self, msg):
        method, p = msg['method'], msg.get('params', {})
        if 'id' in msg:
            supported = ('item/tool/requestUserInput', 'tool/requestUserInput', 'item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'mcpServer/elicitation/request')
            if method in supported:
                # RPC ids can restart at zero on a new Codex process. A stale
                # mobile page must never approve a different request with that id.
                client_id = secrets.token_urlsafe(18)
                self.pending[client_id] = {**msg, 'clientRequestId': client_id}
            elif method == 'item/tool/call':
                await self.write({'id': msg['id'], 'result': {'contentItems': [{'type': 'inputText', 'text': '此手机客户端不支持执行桌面专属动态工具。请使用内置工具，或请用户交还桌面。'}], 'success': False}})
            else:
                await self.write({'id': msg['id'], 'error': {'code': -32601, 'message': 'Unsupported mobile client request'}})
            return
        if method == 'serverRequest/resolved':
            self.pending = {k: v for k, v in self.pending.items() if v.get('id') != p.get('requestId')}
        if p.get('threadId') != self.active:
            return
        if method == 'turn/started':
            self.turn = p['turn']['id']
        elif method == 'turn/completed':
            self.completed_turns.add(p['turn']['id'])
            audit('turn_completed', threadId=self.active, turnId=p['turn']['id'], status=p['turn'].get('status'))
            self.turn = None
            self.pending = {k: v for k, v in self.pending.items() if v.get('params', {}).get('threadId') != self.active}
            if p['turn'].get('error'):
                self.error = p['turn']['error'].get('message', '本轮失败')
        elif method in ('item/started', 'item/completed'):
            item = p['item']
            self.items[item['id']] = item
        elif method == 'item/agentMessage/delta':
            item = self.items.setdefault(p['itemId'], {'id': p['itemId'], 'type': 'agentMessage', 'text': ''})
            item['text'] = item.get('text', '') + p['delta']

    async def close(self):
        if self.proc and self.proc.returncode is None:
            self.proc.terminate()
            await self.proc.wait()
        for task in self.tasks:
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        self.tasks.clear()
        self.proc = None
        self.active = None
        self.turn = None
        self.items.clear()
        self.pending.clear()
        self.error = None

bridge = Bridge()
shared_config = cfg.get('sharedDesktop', cfg.get('sharedLab', {}))
shared = SharedQueue(DB_PATH, DesktopAdapter(shared_config.get('node', ''), ROOT, bool(cfg.get('sharedDesktop'))),
    shared_config.get('threads', {}), all_local=shared_config.get('allLocal', False))
composer = MobileComposer(shared)
media = MediaStore(Path(os.environ.get('MOBILE_MEDIA_ROOT',str(RUNTIME / 'media'))), shared_config.get('node'))
usage = UsageService(DesktopAdapter(shared_config.get('node', ''), ROOT, bool(cfg.get('sharedDesktop'))), DB_PATH, shared.all_local)
if shared.all_local:
    shared.workflow = composer

async def ensure_shared(tid):
    if not shared.all_local or shared.enabled(tid):
        return
    async with bridge.lock:
        await bridge.start()
        result = await bridge.call('thread/read', {'threadId':tid,'includeTurns':False})
    t = result['thread']
    if not isinstance(t.get('source'),str) or t['source'] not in ('cli','vscode','appServer'):
        raise HTTPException(409, '此类对话暂不支持双端共用，请在电脑处理')
    shared.register(tid,t.get('name') or t.get('preview'))

@asynccontextmanager
async def lifespan(app):
    await asyncio.to_thread(media.cleanup)
    async def clean_media():
        while True:
            await asyncio.sleep(86400)
            await asyncio.to_thread(media.cleanup)
    media_cleanup=asyncio.create_task(clean_media())
    shared.start()
    try:
        yield
    finally:
        media_cleanup.cancel()
        await asyncio.gather(media_cleanup,return_exceptions=True)
        await usage.close()
        await shared.close()
        await bridge.close()

app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

@app.middleware('http')
async def security(request: Request, call_next):
    if request.url.path=='/api/media/upload':
        length=request.headers.get('content-length','')
        if not length.isdigit() or int(length)>MAX_UPLOAD+1024*1024:
            return JSONResponse({'detail':'附件上传需要明确大小，单个视频最多 100 MiB'},413)
    allowed_hosts = {origin.split('://', 1)[1] for origin in cfg['origins']}
    if request.headers.get('host') not in allowed_hosts:
        return JSONResponse({'detail': '访问地址未授权'}, 403)
    if request.method not in ('GET', 'HEAD'):
        if request.headers.get('origin') not in cfg['origins'] or request.headers.get('x-mobile-client') != '1':
            return JSONResponse({'detail': '请求来源未授权'}, 403)
    public = request.url.path in ('/', '/api/login') or request.url.path.startswith('/static/')
    if not public:
        sid = request.cookies.get('mobile_session', '')
        if sessions.get(sid, 0) < time.time():
            return JSONResponse({'detail': '请先登录'}, 401)
    response = await call_next(request)
    response.headers.update({'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"})
    return response

@app.exception_handler(RpcError)
async def rpc_error(request, exc):
    message = str(exc)
    if 'active writer' in message:
        message = '电脑 Codex 仍占用此对话。请先结束该对话中的工作并退出桌面 Codex，然后再接管。历史未修改。'
    return JSONResponse({'detail': message}, 409)

class Login(BaseModel):
    password: str = Field(max_length=200)

@app.post('/api/login')
async def login(body: Login, request: Request):
    key = request.client.host
    recent = [t for t in attempts.get(key, []) if t > time.time() - 60]
    attempts[key] = recent
    if len(recent) >= 10:
        raise HTTPException(429, '尝试过多，请一分钟后重试')
    if not hmac.compare_digest(body.password.encode(), cfg['password'].encode()):
        recent.append(time.time())
        raise HTTPException(401, '访问口令不正确')
    sid = secrets.token_urlsafe(32)
    sessions[sid] = time.time() + 12 * 3600
    audit('login', userAgent=request.headers.get('user-agent', '')[:250])
    response = JSONResponse({'ok': True})
    response.set_cookie('mobile_session', sid, httponly=True, secure=request.headers['origin'].startswith('https://'), samesite='strict', max_age=12 * 3600)
    return response

@app.post('/api/logout')
async def logout(request: Request):
    sessions.pop(request.cookies.get('mobile_session'), None)
    response = JSONResponse({'ok': True})
    response.delete_cookie('mobile_session')
    return response

@app.get('/')
async def index():
    return FileResponse(ROOT / 'static/index.html')

app.mount('/static', StaticFiles(directory=ROOT / 'static'), name='static')

@app.post('/api/media/upload')
async def upload_image(request: Request, uploadId: str = Form(...), file: UploadFile = File(...)):
    try:
        media_identity(uploadId)
        data = await file.read(MAX_UPLOAD+1)
        value = await asyncio.to_thread(media.ingest,data,uploadId,file.filename or '图片')
        return media.public(value)
    except ValueError as exc:
        raise HTTPException(400,str(exc))
    finally:
        await file.close()

@app.get('/api/media/{asset_id}/status')
async def image_status(asset_id: str):
    try:
        return media.public(media.get(asset_id,True))
    except ValueError as exc:
        raise HTTPException(404,str(exc))

@app.get('/api/media/{asset_id}/content')
async def image_content(asset_id: str, variant: str = 'full'):
    if variant not in ('full','thumb'):
        raise HTTPException(400,'图片版本无效')
    try:
        value=media.get(asset_id,True)
        path=Path(value['thumbPath' if variant=='thumb' else 'path']).resolve(strict=True)
        if media.root not in path.parents:
            raise ValueError('图片文件不可用')
        return FileResponse(path,media_type=('image/png' if path.suffix=='.png' else 'image/jpeg') if variant=='thumb' and value.get('kind')!='video' else value['mime'])
    except (ValueError,OSError) as exc:
        raise HTTPException(404,'图片已失效或暂不可用')

class MediaDraft(BaseModel):
    key: str = Field(max_length=80)
    attachments: list[str] = Field(default_factory=list,max_length=10)

@app.post('/api/media/draft')
async def image_draft(body: MediaDraft):
    try:
        if body.key!='new':
            media_identity(body.key)
        media.attachments(body.attachments)
        media.bind('draft:'+body.key,body.attachments,replace=True)
        return {'ok':True}
    except ValueError as exc:
        raise HTTPException(400,str(exc))

@app.get('/api/threads')
async def threads(cursor: str | None = None):
    if cfg.get('sharedOnly'):
        return {'data':[{'id':tid,'name':name,'mode':'shared'} for tid,name in shared.threads.items()], 'nextCursor':None}
    async with bridge.lock:
        await bridge.start()
        result = await bridge.call('thread/list', {'limit': 40, 'sortKey': 'updated_at', 'cursor': cursor, 'useStateDbOnly': True,
            **({'sourceKinds':['cli','vscode','appServer']} if shared.all_local else {})})
    if shared.all_local:
        for t in result['data']:
            shared.register(t['id'],t.get('name') or t.get('preview'))
        return {'data':[{**{k:t.get(k) for k in ('id','name','preview','updatedAt','cwd')},'mode':'shared'} for t in result['data']], 'nextCursor':result.get('nextCursor')}
    data = [{k: t.get(k) for k in ('id', 'name', 'preview', 'updatedAt', 'cwd')} for t in result['data'] if not shared.enabled(t['id'])]
    if not cursor:
        data = [{'id':tid,'name':name,'mode':'shared'} for tid,name in shared.threads.items()] + data
    return {'data':data, 'nextCursor': result.get('nextCursor')}


@app.get('/api/capabilities')
async def capabilities():
    if not shared.all_local:
        return {'create':False,'settings':False,'projects':[],'models':[],'desktop':{'connected':False}}
    result = await composer.capabilities()
    if cfg.get('sharedDesktop'):
        upgrade = upgrade_status(RUNTIME, result)
        if upgrade:
            result = {**result,'upgrade':upgrade}
    return result


@app.get('/api/usage')
async def usage_limits(refresh: bool = False):
    return await usage.get(refresh)


class CreateThread(BaseModel):
    requestId: str = Field(max_length=80)
    messageId: str = Field(max_length=80)
    target: dict
    text: str = Field(default='',max_length=50000)
    attachments: list[str] = Field(default_factory=list,max_length=10)
    model: str | None = Field(default=None,max_length=200)
    effort: str | None = Field(default=None,max_length=50)
    mode: str = Field(default='default',max_length=20)


@app.post('/api/threads')
async def create_thread(body: CreateThread):
    if not shared.all_local:
        raise HTTPException(409,'新建对话需要双端共用模式')
    try:
        payload=body.model_dump(exclude={'attachments'})
        images=media.attachments(body.attachments)
        if images:
            payload['attachments']=images
        result=composer.create(payload)
        media.bind('creation:'+body.requestId,body.attachments)
        return result
    except ValueError as exc:
        raise HTTPException(409,str(exc))


@app.get('/api/threads/requests')
async def creation_requests():
    return {'data':composer.creations()}


class WorkflowId(BaseModel):
    requestId: str = Field(max_length=80)


@app.post('/api/threads/cancel')
async def cancel_creation(body: WorkflowId):
    try:
        return composer.cancel(body.requestId)
    except ValueError as exc:
        raise HTTPException(409,str(exc))


class ThreadSettings(BaseModel):
    requestId: str = Field(max_length=80)
    threadId: str = Field(max_length=80)
    version: str = Field(max_length=1000)
    model: str = Field(min_length=1,max_length=200)
    effort: str = Field(min_length=1,max_length=50)
    mode: str | None = Field(default=None,max_length=20)


@app.post('/api/thread/settings')
async def thread_settings(body: ThreadSettings):
    await ensure_shared(body.threadId)
    if not shared.enabled(body.threadId):
        raise HTTPException(409,'此对话尚未启用共用模式')
    try:
        return await composer.apply_settings(body.model_dump())
    except ValueError as exc:
        raise HTTPException(409,str(exc))

class ImplementPlan(BaseModel):
    requestId: str = Field(max_length=80)
    messageId: str = Field(max_length=80)
    threadId: str = Field(max_length=80)
    version: str = Field(max_length=1000)
    planId: str = Field(max_length=200)
    turnId: str = Field(max_length=100)


@app.post('/api/plan/implement')
async def implement_plan(body: ImplementPlan):
    await ensure_shared(body.threadId)
    if not shared.enabled(body.threadId):
        raise HTTPException(409,'此对话尚未启用共用模式')
    try:
        return await composer.implement_plan(body.model_dump())
    except ValueError as exc:
        raise HTTPException(409,str(exc))

@app.get('/api/thread/{tid}')
async def thread(tid: str):
    await ensure_shared(tid)
    if shared.enabled(tid):
        if shared.all_local and not shared.saved(tid).get('thread'):
            async with bridge.lock:
                await bridge.start()
                page = await bridge.call('thread/turns/list', {'threadId':tid,'limit':20,'itemsView':'summary','sortDirection':'desc'})
            turns=[{**{k:turn.get(k) for k in ('id','status','error')},'items':[item for item in turn.get('items',[]) if item.get('type') in ('userMessage','agentMessage','imageGeneration')]} for turn in reversed(page['data'])]
            snapshot={'thread':{'id':tid,'name':shared.threads[tid],'turns':turns,'hasOlder':bool(page.get('nextCursor'))}}
            if not shared.saved(tid).get('thread'):
                shared.db.execute('INSERT OR REPLACE INTO mobile_snapshots VALUES(?,?)',(tid,json.dumps(snapshot)))
                shared.db.commit()
        return await media.project({'thread':shared.state(tid)['thread'], 'mode':'shared'},'thread:'+tid)
    async with bridge.lock:
        await bridge.start()
        result = await bridge.call('thread/read', {'threadId': tid, 'includeTurns': True})
        t = result['thread']
        # The model retains the complete original history; the phone only needs
        # conversation text, not command output, environment data or tool payloads.
        return await media.project({'thread': {**{k: t.get(k) for k in ('id', 'name', 'historyMode', 'status')}, 'turns': [{'id': turn['id'], 'status': turn.get('status'), 'items': [i for i in turn.get('items', []) if i.get('type') in ('userMessage', 'agentMessage','imageGeneration')]} for turn in t.get('turns', [])]}},'thread:'+tid)

@app.post('/api/takeover/{tid}')
async def takeover(tid: str):
    await ensure_shared(tid)
    if shared.enabled(tid):
        raise HTTPException(409, '此对话由桌面执行，无需手机接管')
    async with bridge.lock:
        if bridge.active:
            if bridge.active == tid:
                return {'threadId': tid}
            raise HTTPException(409, '请先交还当前对话')
        await bridge.start()
        result = await bridge.call('thread/resume', {'threadId': tid})
        bridge.active = tid
        bridge.model = result.get('model')
        bridge.reasoning = result.get('reasoningEffort')
        bridge.error = None
        bridge.items.clear()
        audit('takeover', threadId=tid, returnedId=result['thread']['id'], historyMode=result['thread'].get('historyMode'), returnedTurns=len(result['thread'].get('turns', [])))
        return {'threadId': result['thread']['id']}

@app.post('/api/release')
async def release():
    async with bridge.lock:
        if bridge.turn or bridge.pending:
            raise HTTPException(409, '请先等待本轮结束，或点击停止本轮')
        # Exit our own process to release its writer lock deterministically.
        await bridge.close()
        audit('released')
        return {'ok': True}

class Prompt(BaseModel):
    id: str = Field(min_length=16, max_length=80)
    threadId: str
    text: str = Field(default='', max_length=50000)
    attachments: list[str] = Field(default_factory=list,max_length=10)
    plan: bool = False

@app.post('/api/send')
async def send(body: Prompt, request: Request):
    try:
        images=media.attachments(body.attachments)
    except ValueError as exc:
        raise HTTPException(400,str(exc))
    await ensure_shared(body.threadId)
    if shared.enabled(body.threadId):
        try:
            result=await shared.enqueue(body.threadId, body.id, body.text, body.plan,images)
            media.bind('message:'+body.id,body.attachments)
            return result
        except ValueError as exc:
            raise HTTPException(409, str(exc))
    async with bridge.lock:
        payload=body.model_dump(exclude={'attachments'})
        if images:
            payload['attachments']=images
        digest = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
        previous = db.execute('SELECT digest,status,result FROM deliveries WHERE id=?', (body.id,)).fetchone()
        if previous:
            if previous[0] != digest:
                raise HTTPException(409, '发送标识已用于其他消息')
            if previous[1] == 'sent':
                return json.loads(previous[2])
            raise HTTPException(409, '此前发送结果不确定。请刷新历史核对，系统不会自动重复发送。')
        if bridge.active != body.threadId:
            raise HTTPException(409, '请先接管此对话')
        if bridge.turn:
            raise HTTPException(409, '本轮仍在进行，请等待或停止')
        if not body.text.strip() and not images:
            raise HTTPException(400, '请输入文字')
        if any(image.get('kind')=='video' for image in images):
            raise HTTPException(409,'视频附件需要双端共用模式，请先连接兼容桌面')
        if bridge.pending:
            raise HTTPException(409, '请先回答当前问题或停止本轮')
        db.execute('INSERT INTO deliveries VALUES (?,?,?,?)', (body.id, digest, 'pending', None))
        db.commit()
        params = {'threadId': body.threadId, 'input': ([{'type': 'text', 'text': body.text}] if body.text.strip() else [])+[{'type':'localImage','path':image['localPath']} for image in images]}
        media.bind('message:'+body.id,body.attachments)
        params['collaborationMode'] = {'mode': 'plan' if body.plan else 'default', 'settings': {'model': bridge.model, 'reasoning_effort': bridge.reasoning, 'developer_instructions': None}}
        bridge.error = None
        bridge.items.clear()
        result = await bridge.call('turn/start', params)
        if result['turn'].get('status') == 'inProgress' and result['turn']['id'] not in bridge.completed_turns:
            bridge.turn = result['turn']['id']
        response = {'turnId': result['turn']['id']}
        db.execute('UPDATE deliveries SET status=?,result=? WHERE id=?', ('sent', json.dumps(response), body.id))
        db.commit()
        audit('send_accepted', threadId=body.threadId, turnId=response['turnId'], userAgent=request.headers.get('user-agent', '')[:250])
        return response

@app.post('/api/interrupt')
async def interrupt():
    async with bridge.lock:
        if bridge.turn:
            await bridge.call('turn/interrupt', {'threadId': bridge.active, 'turnId': bridge.turn})
        return {'ok': True}

register_turn_routes(app, shared, ensure_shared)

@app.get('/api/events')
async def events(request: Request, threadId: str):
    await ensure_shared(threadId)
    if not shared.enabled(threadId):
        raise HTTPException(409, '实时回复仅适用于双端共用对话')
    sid = request.cookies.get('mobile_session', '')

    async def feed():
        async with aclosing(shared.stream(threadId)) as stream:
            async for value in stream:
                if sessions.get(sid, 0) < time.time() or await request.is_disconnected():
                    break
                projected=await media.project(value,'thread:'+threadId)
                yield 'event: transcript\ndata: ' + json.dumps(projected, ensure_ascii=False) + '\n\n'
    return StreamingResponse(feed(), media_type='text/event-stream', headers={'X-Accel-Buffering':'no'})


@app.get('/api/state')
async def state(request: Request, threadId: str | None = None):
    if threadId:
        await ensure_shared(threadId)
    if shared.enabled(threadId):
        result = shared.state(threadId)
        result['desktopLaunch'] = latest_request(threadId)
        return await media.project(result,'thread:'+threadId)
    sid = request.cookies.get('mobile_session', '')
    now = time.time()
    if sid in session_seen and now - session_seen[sid] > 8:
        audit('client_reconnected', threadId=bridge.active, pendingCount=len(bridge.pending), userAgent=request.headers.get('user-agent', '')[:250])
    session_seen[sid] = now
    requested_items = {v['params'].get('itemId') for v in bridge.pending.values()}
    visible_items = [i for i in bridge.items.values() if i.get('type') in ('userMessage', 'agentMessage', 'imageGeneration') or i.get('id') in requested_items]
    return await media.project({'mode':'alternating', 'serviceMode':'shared' if shared.all_local else 'alternating', 'threadId': bridge.active, 'turnId': bridge.turn, 'items': visible_items, 'pending': list(bridge.pending.values()), 'error': bridge.error},'thread:'+str(bridge.active))

class Cancel(BaseModel):
    threadId: str
    messageId: str

class OpenDesktop(BaseModel):
    threadId: str

@app.post('/api/desktop/open')
async def open_desktop(body: OpenDesktop):
    await ensure_shared(body.threadId)
    if not shared.all_local or not shared.enabled(body.threadId):
        raise HTTPException(409, '此对话尚未启用桌面共用连接')
    connection = await shared.probe(body.threadId)
    if connection['connected']:
        return {'ok':True,'status':'connected'}
    if connection.get('code') in ('original-owner','incompatible'):
        raise HTTPException(409,connection['reason'])
    try:
        return await request_open(body.threadId)
    except (ValueError,RuntimeError) as exc:
        raise HTTPException(409,str(exc))

@app.post('/api/queue/cancel')
async def cancel_queued(body: Cancel):
    if not shared.enabled(body.threadId):
        raise HTTPException(409, '此对话尚未启用共用模式')
    try:
        return shared.cancel(body.threadId, body.messageId)
    except ValueError as exc:
        raise HTTPException(409, str(exc))

class Answer(BaseModel):
    requestId: str
    threadId: str | None = None
    answers: dict[str, str] = Field(default_factory=dict)
    decision: str | None = None

def answer_payload(msg, body):
    method, p = msg['method'], msg['params']
    if method.endswith('requestUserInput'):
        answers = {}
        for q in p['questions']:
            answer = body.answers.get(q['id'], '')
            labels = [o['label'] for o in q.get('options') or []]
            if not answer or len(answer) > 10000:
                raise HTTPException(400, '请回答每个问题')
            if labels and not q.get('isOther') and answer not in labels:
                raise HTTPException(400, '请选择题目提供的选项')
            answers[q['id']] = {'answers': [answer]}
        return {'answers': answers}
    if method in ('item/commandExecution/requestApproval', 'item/fileChange/requestApproval'):
        allowed = p.get('availableDecisions') or ['accept', 'decline', 'cancel']
        if body.decision not in ('accept', 'decline', 'cancel') or body.decision not in allowed:
            raise HTTPException(400, '审批选项无效')
        return {'decision': body.decision}
    if method == 'item/permissions/requestApproval':
        if body.decision not in ('accept', 'decline'):
            raise HTTPException(400, '审批选项无效')
        return {'permissions': p['permissions'] if body.decision == 'accept' else {}, 'scope': 'turn'}
    if method == 'mcpServer/elicitation/request':
        # Form schemas and external-login flows must be handled by the desktop.
        if body.decision not in ('decline', 'cancel'):
            raise HTTPException(400, '此类表单请在桌面处理，手机可拒绝或取消')
        return {'action': body.decision, 'content': None}
    raise HTTPException(400, '不支持的请求')

@app.post('/api/answer')
async def answer(body: Answer, request: Request):
    if shared.enabled(body.threadId):
        try:
            return await shared.answer(body.threadId, body.requestId, body.answers, body.decision)
        except ValueError as exc:
            raise HTTPException(409, str(exc))
    async with bridge.lock:
        msg = bridge.pending.get(body.requestId)
        if not msg or msg['params'].get('threadId') != bridge.active:
            raise HTTPException(409, '该问题已结束或已被回答，请刷新')
        result = answer_payload(msg, body)
        await bridge.write({'id': msg['id'], 'result': result})
        bridge.pending.pop(body.requestId, None)
        audit('answer_sent', threadId=bridge.active, requestId=body.requestId, method=msg['method'], questionIds=list(body.answers), decision=body.decision, userAgent=request.headers.get('user-agent', '')[:250])
        return {'ok': True}
