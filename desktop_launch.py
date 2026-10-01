"""Requests to the user's separately scheduled desktop host; never kills another app."""
import asyncio
import json
from contextlib import contextmanager
from pathlib import Path
import sqlite3
import subprocess
import uuid

ROOT=Path(__file__).resolve().parent
PATH=ROOT/'runtime/desktop-requests.sqlite'


def upgrade_status(runtime, capabilities):
    """Reconcile a late readiness acknowledgement without relaunching the app."""
    path = runtime / 'desktop-upgrade.json'
    if not path.exists():
        return None
    value = json.loads(path.read_text(encoding='utf-8'))
    if (value.get('status') in ('failed', 'launching') and
            capabilities.get('protocol') == 'mobile-compose-v1' and
            capabilities.get('desktop', {}).get('connected') is True):
        pointer = json.loads((runtime / 'shared-desktop.json').read_text(encoding='utf-8'))
        if pointer.get('manifest') == value.get('manifest'):
            value.update(status='ready')
            value.pop('reason', None)
            temporary = path.with_suffix('.web.tmp')
            temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
            temporary.replace(path)
    return {'status': value.get('status'), 'build': value.get('build')}

@contextmanager
def connect():
    db=sqlite3.connect(PATH,timeout=10)
    try:
        db.execute('CREATE TABLE IF NOT EXISTS launches(id INTEGER PRIMARY KEY AUTOINCREMENT, thread TEXT, status TEXT NOT NULL, error TEXT)')
        with db:
            yield db
    finally:
        db.close()

async def request_open(thread_id=None):
    if thread_id and str(uuid.UUID(thread_id))!=thread_id:raise ValueError('Invalid thread ID')
    with connect() as db:
        request_id=db.execute("INSERT INTO launches(thread,status) VALUES(?,'waiting')",(thread_id,)).lastrowid
    proc=await asyncio.create_subprocess_exec('powershell.exe','-NoProfile','-NonInteractive','-Command',
        "Start-ScheduledTask -TaskName 'Codex-Mobile-Desktop' -ErrorAction Stop",
        stdout=asyncio.subprocess.DEVNULL,stderr=asyncio.subprocess.DEVNULL,creationflags=subprocess.CREATE_NO_WINDOW)
    if await proc.wait()!=0:
        with connect() as db:
            db.execute("UPDATE launches SET status='failed',error='Desktop host could not start' WHERE id=?",(request_id,))
        raise RuntimeError('无法启动兼容桌面，请运行桌面的“Codex 双端共用”快捷方式')
    return {'ok':True,'requestId':request_id,'status':'requested'}

def latest_request(thread_id):
    if not PATH.exists():return None
    with connect() as db:
        row=db.execute('SELECT id,status FROM launches WHERE thread=? ORDER BY id DESC LIMIT 1',(thread_id,)).fetchone()
    if not row:return None
    return {'requestId':row[0],'status':row[1]}
