"""Durable desktop creation and settings workflows; never starts an executor."""
import asyncio
import json
import time
import uuid
from shared_queue import DesktopUnavailable


def identity(value):
    try:
        if str(uuid.UUID(value)) != value:
            raise ValueError()
    except (ValueError, TypeError, AttributeError):
        raise ValueError('请求标识无效')
    return value


class MobileComposer:
    def __init__(self, queue):
        self.queue, self.db, self.adapter = queue, queue.db, queue.adapter
        self.lock = asyncio.Lock()
        self.cap_time, self.cap_state = 0, None
        self.db.execute('CREATE TABLE IF NOT EXISTS mobile_capabilities (id INTEGER PRIMARY KEY, value TEXT NOT NULL)')
        self.db.execute('''CREATE TABLE IF NOT EXISTS mobile_creations (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,
            payload TEXT NOT NULL,status TEXT NOT NULL,thread TEXT,reason TEXT)''')
        self.db.execute('''CREATE TABLE IF NOT EXISTS mobile_settings_operations (
            id TEXT PRIMARY KEY,thread TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL,result TEXT)''')
        self.db.execute('''CREATE TABLE IF NOT EXISTS mobile_plan_operations (
            id TEXT PRIMARY KEY,thread TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL,result TEXT)''')
        self.db.commit()

    async def capabilities(self, refresh=False):
        if not refresh and self.cap_state and time.monotonic()-self.cap_time < 8:
            return self.cap_state
        row = self.db.execute('SELECT value FROM mobile_capabilities WHERE id=1').fetchone()
        previous = json.loads(row[0]) if row else {'projects':[], 'models':[], 'defaults':{'inherit':True}}
        try:
            value = await self.adapter.call('capabilities', None)
            if value.get('protocol') != 'mobile-compose-v1':
                raise RuntimeError('Unsupported creation capability')
            self.db.execute('INSERT OR REPLACE INTO mobile_capabilities VALUES(1,?)',(json.dumps(value),))
            self.db.commit()
            result = {**value, 'desktop':{'connected':True}, 'stale':False}
        except Exception:
            result = {**previous, 'desktop':{'connected':False,
                'reason':'等待兼容桌面连接；首次使用此功能需要更新桌面副本'}, 'stale':True}
        self.cap_state, self.cap_time = result, time.monotonic()
        return result

    def creations(self):
        return [self.creation_value(row) for row in self.db.execute('SELECT * FROM mobile_creations ORDER BY seq DESC LIMIT 100')]

    def creation_value(self, row):
        value = dict(row)
        payload = json.loads(value.pop('payload'))
        value.update(text=payload['text'], target=payload['target'], messageId=payload['messageId'])
        value['requestId'] = value.pop('id')
        value['threadId'] = value.pop('thread')
        if value['threadId']:
            message = self.db.execute('SELECT status FROM mobile_outbox WHERE id=?',(payload['messageId'],)).fetchone()
            value['messageStatus'] = message[0] if message else 'waiting'
        return value

    def creation(self, request_id):
        row = self.db.execute('SELECT * FROM mobile_creations WHERE id=?',(request_id,)).fetchone()
        return self.creation_value(row) if row else None

    def create(self, payload):
        payload = dict(payload)
        request_id = identity(payload.pop('requestId'))
        identity(payload.get('messageId'))
        target = payload.get('target', {})
        if (target.get('type') not in ('project','projectless') or
                set(target)-{'type','projectId'} or
                (target['type']=='project' and not isinstance(target.get('projectId'),str)) or
                (target['type']=='projectless' and target.get('projectId') is not None)):
            raise ValueError('请选择已有项目或独立对话')
        text = payload.get('text')
        if not isinstance(text,str) or (not text.strip() and not payload.get('attachments')) or len(text.encode()) > 32000:
            raise ValueError('请输入首条消息，最多 32000 字节')
        if (payload.get('model') is None) != (payload.get('effort') is None):
            raise ValueError('请选择模型及其思考强度，或沿用桌面默认设置')
        if payload.get('mode', 'default') not in ('plan', 'default'):
            raise ValueError('模式无效')
        serialized = json.dumps(payload,sort_keys=True)
        previous = self.db.execute('SELECT payload FROM mobile_creations WHERE id=?',(request_id,)).fetchone()
        if previous and previous[0] != serialized:
            raise ValueError('创建标识已用于其他内容')
        if not previous:
            if self.db.execute("SELECT 1 FROM mobile_creations WHERE json_extract(payload,'$.messageId')=?",(payload['messageId'],)).fetchone() or self.db.execute('SELECT 1 FROM mobile_outbox WHERE id=?',(payload['messageId'],)).fetchone():
                raise ValueError('首条消息标识已用于其他请求')
            self.db.execute('INSERT INTO mobile_creations(id,payload,status) VALUES(?,?,?)',(request_id,serialized,'waiting'))
            self.db.commit()
        return self.creation(request_id)

    def cancel(self, request_id):
        cursor = self.db.execute("UPDATE mobile_creations SET status='cancelled' WHERE id=? AND status='waiting'",(request_id,))
        self.db.commit()
        if not cursor.rowcount:
            raise ValueError('已经开始转交，不能撤回；请等待结果核对')
        return self.creation(request_id)

    def update_creation(self, request_id, status, thread=None, reason=None):
        self.db.execute('UPDATE mobile_creations SET status=?,thread=COALESCE(?,thread),reason=? WHERE id=?',(status,thread,reason,request_id))
        self.db.commit()

    async def sync(self):
        async with self.lock:
            rows = list(self.db.execute("SELECT * FROM mobile_creations WHERE status IN ('waiting','checking','needs-review','created') ORDER BY seq"))
            caps = await self.capabilities(refresh=any(row['status']=='waiting' for row in rows)) if rows else None
            for row in rows:
                payload = json.loads(row['payload'])
                status, tid = row['status'], row['thread']
                if status != 'created':
                    if not caps['desktop']['connected']:
                        continue
                    if status == 'waiting':
                        if (any(a.get('kind')=='video' for a in payload.get('attachments',[])) and not caps.get('videoInputs')
                                or any(a.get('kind')!='video' for a in payload.get('attachments',[])) and not caps.get('imageInputs')):
                            continue
                        if payload.get('mode') == 'plan' and not caps.get('planMode'):
                            continue  # Keep cancellable until the native desktop is upgraded.
                        self.update_creation(row['id'],'checking')
                        operation, params = 'create', payload
                    else:
                        # Query-only reconciliation. Even 'not-received' is not
                        # permission to replay a request that may still be in flight.
                        operation, params = 'creation-status', {}
                    try:
                        result = await self.adapter.call(operation,None,requestId=row['id'],**params)
                    except DesktopUnavailable:
                        if status == 'waiting':
                            self.update_creation(row['id'],'waiting')
                        continue
                    except Exception:
                        self.update_creation(row['id'],'needs-review',reason='创建结果待核对；不会重复创建')
                        continue
                    if result.get('status') == 'created':
                        tid = identity(result['threadId'])
                        if result.get('ready') is False:
                            self.update_creation(row['id'],'needs-review',tid,reason='对话已创建，但桌面初始化未完成；首条消息已暂停，请在电脑检查')
                            continue
                        self.update_creation(row['id'],'created',tid)
                    elif result.get('status') == 'invalid':
                        self.update_creation(row['id'],'invalid',reason='项目或模型选项已失效，请重新选择；输入已保留')
                        continue
                    else:
                        self.update_creation(row['id'],'needs-review',reason='创建结果待核对；不会重复创建')
                        continue
                self.queue.register(tid,payload['text'][:80])
                if not self.queue.saved(tid).get('thread'):
                    self.db.execute('INSERT OR REPLACE INTO mobile_snapshots VALUES(?,?)',(tid,json.dumps({'thread':{'id':tid,'name':payload['text'][:80],'turns':[]}})))
                    self.db.commit()
                await self.queue.enqueue(tid,payload['messageId'],payload['text'],attachments=payload.get('attachments'))
                self.update_creation(row['id'],'complete',tid)
            for row in list(self.db.execute("SELECT * FROM mobile_settings_operations WHERE status='uncertain'")):
                try:
                    result = await self.adapter.call('settings-status',row['thread'],requestId=row['id'])
                    self.save_settings_result(row['id'],result)
                except Exception:
                    pass
            for row in list(self.db.execute("SELECT * FROM mobile_plan_operations WHERE status='uncertain'")):
                try:
                    result = await self.adapter.call('implementation-status',row['thread'],requestId=row['id'])
                    self.save_implementation(row['id'],result)
                except Exception:
                    pass

    def save_settings_result(self, request_id, result):
        status = result.get('status')
        if status not in ('applied','conflict','unsupported','invalid'):
            status = 'uncertain'
            result = {'status':status}
        self.db.execute('UPDATE mobile_settings_operations SET status=?,result=? WHERE id=?',(status,json.dumps(result),request_id))
        self.db.commit()
        return result

    def settings_pending(self, tid):
        row = self.db.execute("SELECT id,status,result FROM mobile_settings_operations WHERE thread=? ORDER BY rowid DESC LIMIT 1",(tid,)).fetchone()
        return {'requestId':row['id'],'status':row['status'], 'result':json.loads(row['result']) if row['result'] else None} if row else None

    async def apply_settings(self, payload):
        request_id = identity(payload['requestId'])
        tid = identity(payload['threadId'])
        if payload.get('mode') is not None and payload['mode'] not in ('plan', 'default'):
            raise ValueError('模式无效')
        serialized = json.dumps(payload,sort_keys=True)
        async with self.lock:
            previous = self.db.execute('SELECT * FROM mobile_settings_operations WHERE id=?',(request_id,)).fetchone()
            if previous:
                if previous['payload'] != serialized:
                    raise ValueError('设置请求标识已用于其他内容')
                return json.loads(previous['result']) if previous['result'] else {'status':previous['status']}
            if self.db.execute("SELECT 1 FROM mobile_settings_operations WHERE thread=? AND status='uncertain'",(tid,)).fetchone():
                raise ValueError('上次设置结果待核对，暂不能再次修改')
            if self.implementation_pending(tid) and self.implementation_pending(tid)['status']=='uncertain':
                raise ValueError('采用方案结果待核对，暂不能修改设置')
            if not (await self.queue.probe(tid))['connected']:
                raise ValueError('电脑未连接，设置暂不能应用')
            current = self.queue.saved(tid).get('settings')
            if payload.get('mode') is not None and not self.queue.saved(tid).get('planMode'):
                return {'status':'unsupported'}
            if not current or payload['version'] != current['version']:
                return {'status':'conflict','settings':current}
            self.db.execute('INSERT INTO mobile_settings_operations VALUES(?,?,?,?,NULL)',(request_id,tid,serialized,'uncertain'))
            self.db.commit()
            try:
                result = await self.adapter.call('settings',tid,requestId=request_id,version=payload['version'],model=payload['model'],effort=payload['effort'],
                    **({'mode':payload['mode']} if payload.get('mode') is not None else {}))
            except Exception:
                result = {'status':'uncertain'}
            return self.save_settings_result(request_id,result)

    def save_implementation(self, request_id, result):
        status = result.get('status')
        if status not in ('applied','conflict','busy','unsupported'):
            status, result = 'uncertain', {'status':'uncertain'}
        self.db.execute('UPDATE mobile_plan_operations SET status=?,result=? WHERE id=?',(status,json.dumps(result),request_id))
        self.db.commit()
        return result

    def implementation_pending(self, tid):
        row=self.db.execute('SELECT id,status,result FROM mobile_plan_operations WHERE thread=? ORDER BY rowid DESC LIMIT 1',(tid,)).fetchone()
        return {'requestId':row['id'],'status':row['status']} if row else None

    async def implement_plan(self, payload):
        request_id, tid = identity(payload['requestId']), identity(payload['threadId'])
        identity(payload['messageId'])
        serialized=json.dumps(payload,sort_keys=True)
        async with self.lock:
            previous=self.db.execute('SELECT * FROM mobile_plan_operations WHERE id=?',(request_id,)).fetchone()
            if previous:
                if previous['payload']!=serialized:
                    raise ValueError('实施请求标识已用于其他内容')
                return json.loads(previous['result']) if previous['result'] else {'status':previous['status']}
            if self.db.execute("SELECT 1 FROM mobile_plan_operations WHERE thread=? AND status='uncertain'",(tid,)).fetchone():
                raise ValueError('上次实施结果待核对，暂不能再次提交')
            # Same queue lane as sends/recovery. Never adopt ahead of a phone
            # message still awaiting transfer, nor convert earlier queued work.
            async with self.queue.lock:
                if any(r['status'] in ('waiting','checking','needs-review','queued') for r in self.queue.rows(tid)):
                    return {'status':'busy'}
                try:
                    await self.queue.read_snapshot(tid)
                except Exception as exc:
                    self.queue.disconnected(tid,exc)
                    raise ValueError('电脑未连接，暂不能采用方案')
                if any(r['status'] in ('waiting','checking','needs-review','queued') for r in self.queue.rows(tid)) or self.settings_pending(tid) and self.settings_pending(tid)['status']=='uncertain':
                    return {'status':'busy'}
                snapshot=self.queue.saved(tid)
                if not snapshot.get('planMode'):
                    return {'status':'unsupported'}
                plan=snapshot.get('planReview')
                if not plan or plan['id']!=payload['planId'] or plan['turnId']!=payload['turnId'] or snapshot.get('settings',{}).get('version')!=payload['version']:
                    return {'status':'conflict'}
                if snapshot.get('turnId') or snapshot.get('queue') or snapshot.get('pending'):
                    return {'status':'busy'}
                self.db.execute('INSERT INTO mobile_plan_operations VALUES(?,?,?,?,NULL)',(request_id,tid,serialized,'uncertain'))
                self.db.commit()
                try:
                    result=await self.adapter.call('implement-plan',tid,requestId=request_id,version=payload['version'],planId=payload['planId'],turnId=payload['turnId'],messageId=payload['messageId'])
                except Exception:
                    result={'status':'uncertain'}
                return self.save_implementation(request_id,result)
