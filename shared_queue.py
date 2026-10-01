"""Durable phone outbox; the desktop owner remains the sole executor."""
import asyncio
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import time
import uuid


class DesktopUnavailable(RuntimeError):
    """Transport proved that no operation reached the desktop."""


class DesktopAdapter:
    def __init__(self, node, root, production=False):
        self.node, self.root, self.proc = node, root, None
        self.production = production
        self.lock = asyncio.Lock()
        self.reader = None
        self.pending = {}
        self.on_event = lambda event: None

    async def read_events(self, proc):
        try:
            while line := await proc.stdout.readline():
                result = json.loads(line)
                if result.get('event') == 'transcript':
                    self.on_event(result)
                else:
                    future = self.pending.get(result.get('id'))
                    if future and not future.done():
                        future.set_result(result)
        finally:
            for future in self.pending.values():
                if not future.done():
                    future.set_exception(RuntimeError('Desktop disconnected'))
            self.on_event({'event':'disconnected'})

    async def call(self, operation, thread_id, **params):
        async with self.lock:
            try:
                if not self.proc or self.proc.returncode is not None:
                    self.proc = await asyncio.create_subprocess_exec(self.node, str(self.root / 'desktop_bridge/mobile_client.mjs'), *(['--shared'] if self.production else []),
                        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
                        limit=32 * 1024 * 1024, creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
                    self.reader = asyncio.create_task(self.read_events(self.proc))
                request_id = str(uuid.uuid4())
                future = asyncio.get_running_loop().create_future()
                self.pending[request_id] = future
                self.proc.stdin.write((json.dumps(dict(id=request_id, operation=operation, threadId=thread_id, **params))+'\n').encode())
                await self.proc.stdin.drain()
                try:
                    result = await asyncio.wait_for(future, 25)
                finally:
                    self.pending.pop(request_id, None)
                if result.get('id') != request_id or 'error' in result:
                    if result.get('notSubmitted') is True:
                        raise DesktopUnavailable(result.get('error','Desktop unavailable'))
                    raise RuntimeError(result.get('error', 'Desktop response mismatch'))
                return result['result']
            except BaseException:
                await self.close()
                raise

    async def close(self):
        if self.proc and self.proc.returncode is None:
            self.proc.terminate()
            await self.proc.wait()
        if self.reader:
            self.reader.cancel()
            await asyncio.gather(self.reader, return_exceptions=True)
            self.reader = None
        self.pending.clear()
        self.proc = None


class SharedQueue:
    def __init__(self, path, adapter, threads, all_local=False):
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.execute('''CREATE TABLE IF NOT EXISTS mobile_outbox (
            seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
            thread TEXT NOT NULL, digest TEXT NOT NULL, text TEXT NOT NULL,
            status TEXT NOT NULL)''')
        self.db.execute('CREATE TABLE IF NOT EXISTS mobile_snapshots (thread TEXT PRIMARY KEY, state TEXT NOT NULL)')
        self.db.execute('CREATE TABLE IF NOT EXISTS mobile_threads (id TEXT PRIMARY KEY, name TEXT NOT NULL)')
        if 'attachments' not in [row[1] for row in self.db.execute('PRAGMA table_info(mobile_outbox)')]:
            self.db.execute("ALTER TABLE mobile_outbox ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'")
        self.db.commit()
        self.adapter, self.threads = adapter, dict(threads)
        self.all_local = all_local
        if all_local:
            self.threads.update(dict(self.db.execute('SELECT id,name FROM mobile_threads')))
        self.touched = {}
        self.lock, self.task = asyncio.Lock(), None
        self.connection = {tid: {'connected':False, 'reason':'等待电脑连接'} for tid in self.threads}
        self.live = {}
        self.listeners = {}
        self.adapter.on_event = self.receive_stream
        self.workflow = None

    def receive_stream(self, event):
        tids = list(self.live) if event.get('event') == 'disconnected' else [event.get('threadId')]
        for tid in tids:
            if not self.enabled(tid):
                continue
            previous = self.live.get(tid, {})
            if event.get('connected'):
                value = {key:event[key] for key in ('turns', 'nickname', 'revision')}
                if event.get('settings'):
                    value['settings'] = event['settings']
                value.update(connected=True, threadId=tid)
            else:
                value = {**previous, 'connected':False, 'threadId':tid}
            if value == previous:
                continue
            self.live[tid] = value
            for listener in self.listeners.get(tid, ()):
                listener.set()

    async def stream(self, tid):
        listener = asyncio.Event()
        self.listeners.setdefault(tid, set()).add(listener)
        try:
            while True:
                listener.clear()
                self.watch(tid)
                yield self.live.get(tid, {'threadId':tid, 'connected':False})
                try:
                    await asyncio.wait_for(listener.wait(), 12)
                except TimeoutError:
                    pass  # A fresh value is also an SSE heartbeat and lease renewal.
        finally:
            self.listeners[tid].discard(listener)
            if not self.listeners[tid]:
                del self.listeners[tid]

    def enabled(self, tid):
        return tid in self.threads

    def register(self, tid, name):
        if not self.all_local:
            return
        if str(uuid.UUID(tid)) != tid:
            raise ValueError('Invalid local thread ID')
        self.threads[tid] = name or '已有对话'
        self.connection.setdefault(tid, {'connected':False, 'reason':'等待兼容桌面连接，可点击“在电脑连接此对话”'})
        self.db.execute('INSERT OR REPLACE INTO mobile_threads VALUES(?,?)', (tid,self.threads[tid]))
        self.db.commit()

    def watch(self, tid):
        self.touched[tid] = time.monotonic()

    def start(self):
        if self.threads or self.all_local:
            self.task = asyncio.create_task(self.run())

    async def close(self):
        if self.task:
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)
        await self.adapter.close()
        self.db.close()

    async def run(self):
        while True:
            if self.workflow:
                await self.workflow.sync()
            waiting = {r[0] for r in self.db.execute("SELECT DISTINCT thread FROM mobile_outbox WHERE status IN ('waiting','checking','needs-review','queued')")}
            for tid in list(self.threads):
                if self.all_local and tid not in waiting and time.monotonic()-self.touched.get(tid,0)>30:
                    continue
                await self.sync(tid)
            await asyncio.sleep(2)

    def rows(self, tid):
        rows = [dict(row) for row in self.db.execute('SELECT id,text,status,attachments FROM mobile_outbox WHERE thread=? ORDER BY seq', (tid,))]
        for row in rows:
            images=json.loads(row.pop('attachments'))
            if images:
                row['attachments']=images
        return rows

    def saved(self, tid):
        row = self.db.execute('SELECT state FROM mobile_snapshots WHERE thread=?', (tid,)).fetchone()
        return json.loads(row[0]) if row else {}

    def state(self, tid):
        self.watch(tid)
        snapshot = self.saved(tid)
        connection = self.connection[tid]
        data = {'mode':'shared', 'serviceMode':'shared', 'threadId':tid, 'turnId':snapshot.get('turnId'),
            'canOpenDesktop':self.all_local,
            'desktop':connection, 'queue':snapshot.get('queue', []), 'outbox':self.rows(tid),
            'pending':snapshot.get('pending', []) if connection['connected'] else [],
            'unsupportedQuestions':snapshot.get('unsupportedQuestions', 0),
            'items':snapshot.get('items', []), 'thread':snapshot.get('thread', {'id':tid, 'name':self.threads[tid], 'turns':[]})}
        data['settings'] = snapshot.get('settings')
        data['turnControl'] = snapshot.get('turnControl')
        data['planMode'] = snapshot.get('planMode', False)
        data['planReview'] = snapshot.get('planReview')
        if self.workflow:
            data['settingsOperation'] = self.workflow.settings_pending(tid)
            data['implementationOperation'] = self.workflow.implementation_pending(tid)
        data['version'] = hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()[:20]
        return data

    async def enqueue(self, tid, message_id, text, plan=False, attachments=None):
        if not self.enabled(tid):
            raise ValueError('此对话尚未启用共用模式')
        operation=self.workflow.implementation_pending(tid) if self.workflow else None
        if operation and operation['status']=='uncertain':
            raise ValueError('采用方案结果待核对，暂不能发送新消息；输入仍保留')
        try:
            if str(uuid.UUID(message_id)) != message_id:
                raise ValueError()
        except ValueError:
            raise ValueError('消息标识无效')
        if plan:
            raise ValueError('共用模式沿用桌面的讨论模式，请在电脑上设置')
        attachments = attachments or []
        if (not text.strip() and not attachments) or len(text.encode()) > 32000:
            raise ValueError('请输入文字，最多 32000 字节（约一万汉字）')
        digest = hashlib.sha256(json.dumps([tid,text]+([attachments] if attachments else [])).encode()).hexdigest()
        # No await in this transaction: arrival order is database sequence order.
        previous = self.db.execute('SELECT digest,status FROM mobile_outbox WHERE id=?', (message_id,)).fetchone()
        if previous and previous['digest'] != digest:
            raise ValueError('发送标识已用于其他消息')
        if not previous:
            self.db.execute('INSERT INTO mobile_outbox(id,thread,digest,text,status,attachments) VALUES(?,?,?,?,?,?)', (message_id,tid,digest,text,'waiting',json.dumps(attachments)))
            self.db.commit()
        return {'messageId':message_id, 'status':previous['status'] if previous else 'waiting'}

    def cancel(self, tid, message_id):
        cursor = self.db.execute("UPDATE mobile_outbox SET status='cancelled' WHERE id=? AND thread=? AND status='waiting'", (message_id,tid))
        self.db.commit()
        if not cursor.rowcount:
            raise ValueError('消息已开始转交，不能从手机撤回；请在电脑查看队列')
        return {'ok':True}

    def update(self, message_id, status):
        self.db.execute('UPDATE mobile_outbox SET status=? WHERE id=?', (status,message_id))
        self.db.commit()

    def disconnected(self, tid, exc):
        self.receive_stream({'threadId':tid, 'connected':False})
        message = str(exc)
        code, reason = 'waiting', '兼容桌面尚未连接此对话，请点击“在电脑连接此对话”'
        if 'Original desktop owns' in message:
            code, reason = 'original-owner', '原版 Codex 正在占用此对话。首次切换需等原版工作结束并完全退出原版，再用“Codex 双端共用”打开原对话；之后兼容桌面保持打开即可双端聊天。'
        elif 'Original desktop running' in message:
            code, reason = 'original-open', '兼容桌面尚未接管此对话，检测到原版 Codex 仍在运行。原版可能仍占用打开过的对话；请先结束其工作并退出原版，再点连接。'
        elif 'verified renderer' in message or 'unverified' in message:
            code, reason = 'background-owner', '此对话由桌面后台持有，请先在兼容桌面打开此对话'
        elif 'not resumed' in message:
            code, reason = 'writer-wait', '等待桌面完成连接；若旧桌面占用此对话，请结束其工作并关闭旧桌面后重试'
        elif 'capability' in message or 'no-handler' in message or 'Unsupported' in message:
            code, reason = 'incompatible', '此桌面版本不兼容，已暂停转交'
        self.connection[tid] = {'connected':False, 'code':code, 'reason':reason}

    async def read_snapshot(self, tid):
        previous = self.saved(tid)
        snapshot = await self.adapter.call('snapshot', tid, knownRevision=previous.get('revision'))
        if snapshot.get('protocol') != 'mobile-queue-v2' or snapshot.get('threadId') != tid:
            raise RuntimeError('Unsupported desktop protocol')
        if 'thread' not in snapshot and 'thread' in previous:
            snapshot['thread'] = previous['thread']
        if snapshot.get('thread') is not None:
            snapshot['thread']['name'] = snapshot['thread'].get('name') or self.threads[tid]
        self.db.execute('INSERT OR REPLACE INTO mobile_snapshots VALUES(?,?)', (tid,json.dumps(snapshot)))
        self.db.commit()
        self.connection[tid] = {'connected':True, 'code':'connected', 'reason':None}
        return snapshot

    async def probe(self, tid):
        # Opening the desktop must not itself forward queued input.
        async with self.lock:
            try:
                await self.read_snapshot(tid)
            except Exception as exc:
                self.disconnected(tid,exc)
            return self.connection[tid]

    async def sync(self, tid):
        async with self.lock:
            try:
                snapshot = await self.read_snapshot(tid)
                receipts = {r['messageId']:r['status'] for r in snapshot['receipts']}
                blocked = False
                for row in self.rows(tid):
                    status = row['status']
                    if status in ('cancelled','executed','accepted-earlier'):
                        continue
                    known = receipts.get(row['id'])
                    if known in ('queued','executed','accepted-earlier'):
                        self.update(row['id'], known)
                        continue
                    if status in ('checking','needs-review','queued'):
                        self.update(row['id'], 'needs-review')
                        blocked = True
                        continue
                    if blocked:
                        continue
                    latest = self.db.execute('SELECT status FROM mobile_outbox WHERE id=?', (row['id'],)).fetchone()[0]
                    if latest != 'waiting':
                        continue
                    attachments=row.get('attachments',[])
                    if (any(a.get('kind')=='video' for a in attachments) and snapshot.get('videoInputs') is not True
                            or any(a.get('kind')!='video' for a in attachments) and snapshot.get('imageInputs') is not True):
                        self.connection[tid]={'connected':True,'reason':'附件已保存，等待兼容桌面完成附件功能更新'}
                        break
                    # Persist ambiguity BEFORE crossing the process boundary.
                    self.update(row['id'], 'checking')
                    try:
                        extra={'attachments':row['attachments']} if row.get('attachments') else {}
                        result = await self.adapter.call('append', tid, messageId=row['id'], text=row['text'], **extra)
                        if result.get('messageId') != row['id'] or result.get('status') not in ('queued','executed','accepted-earlier'):
                            raise RuntimeError('Unconfirmed desktop receipt')
                        self.update(row['id'], result['status'])
                    except Exception:
                        self.update(row['id'], 'needs-review')
                        self.connection[tid] = {'connected':False, 'reason':'发送结果待核对，已暂停后续转交'}
                        break
            except Exception as exc:
                self.disconnected(tid,exc)

    async def answer(self, tid, request_id, answers, decision):
        if not self.enabled(tid):
            raise ValueError('此对话尚未启用共用模式')
        try:
            return await self.adapter.call('answer', tid, requestId=request_id, answers=answers, decision=decision)
        except Exception:
            raise ValueError('答案未确认或问题已结束，请刷新后核对；不会自动重答')
