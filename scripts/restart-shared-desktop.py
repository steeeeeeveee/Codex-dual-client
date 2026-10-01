"""One-shot, user-authorized restart after the requesting reply has finished.

Task Scheduler owns this helper independently of the desktop. Only the verified
project desktop host is stopped; the existing upgrader opens the staged build.
"""
import argparse
import asyncio
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import time
import uuid

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from desktop_launch import request_open
from shared_queue import DesktopAdapter


def write_status(status, **details):
    path=ROOT/'runtime/desktop-restart.json'
    temporary=path.with_suffix('.tmp')
    temporary.write_text(json.dumps({'status':status,'updatedAt':time.time(),**details},indent=2),encoding='utf-8')
    temporary.replace(path)


def verified_manifest(file):
    file=Path(file).resolve()
    if (ROOT/'runtime/desktop-shared').resolve() not in file.parents or file.name!='manifest.json':
        raise ValueError('Restart manifest outside this project')
    value=json.loads(file.read_text(encoding='utf-8'))
    executable=Path(value['executable']).resolve()
    if executable!=file.parent/'app/ChatGPT.exe':raise ValueError('Unexpected desktop executable')
    if hashlib.sha256(executable.read_bytes()).hexdigest()!=value['executableDigest']:
        raise ValueError('Desktop executable changed')
    with (executable.parent/'resources/app.asar').open('rb') as archive:
        import struct
        prefix=archive.read(16);size=struct.unpack_from('<I',prefix,12)[0]
        if size>32*1024*1024 or hashlib.sha256(archive.read(size)).hexdigest()!=value['archiveDigest']:
            raise ValueError('Desktop archive changed')
    return value


def busy(snapshot):
    if snapshot is None:raise ValueError('Cannot prove requesting conversation is idle')
    return bool(snapshot.get('turnId') or snapshot.get('queue') or snapshot.get('pending') or snapshot.get('unsupportedQuestions'))


def stop_project_host():
    # Constant command, with the root passed as data rather than shell source.
    script="""
$ErrorActionPreference='Stop'
$restartRoot=[IO.Path]::GetFullPath($env:CODEX_MOBILE_RESTART_ROOT)
$restartTask=Get-ScheduledTask -TaskName 'Codex-Mobile-Desktop'
$restartPython=Join-Path $restartRoot '.venv\\Scripts\\pythonw.exe'
$restartScript='"'+(Join-Path $restartRoot 'scripts\\desktop-host.py')+'"'
if (@($restartTask.Actions).Count -ne 1 -or $restartTask.Actions.Execute -ne $restartPython -or $restartTask.Actions.Arguments -ne $restartScript -or $restartTask.Actions.WorkingDirectory -ne $restartRoot) { throw 'Unrelated desktop task; preserved' }
Stop-ScheduledTask -TaskName 'Codex-Mobile-Desktop'
"""
    env=dict(os.environ,CODEX_MOBILE_RESTART_ROOT=str(ROOT))
    subprocess.run(['powershell.exe','-NoProfile','-NonInteractive','-Command',script],env=env,
        capture_output=True,check=True,timeout=30,creationflags=subprocess.CREATE_NO_WINDOW)


def phone_threads():
    file=ROOT/'runtime/deliveries.sqlite'
    if not file.exists():return []
    with sqlite3.connect(file.as_uri()+'?mode=ro',uri=True) as db:
        return [row[0] for row in db.execute('SELECT id FROM mobile_threads')]


async def restart(request):
    target=str(uuid.UUID(request['threadId']))
    old=verified_manifest(request['previousManifest'])
    new=verified_manifest(request['manifest'])
    if json.loads((ROOT/'runtime/shared-desktop.json').read_text())['manifest']!=request['previousManifest']:
        raise ValueError('Desktop already changed; restart not performed')
    upgrade=json.loads((ROOT/'runtime/desktop-upgrade.json').read_text())
    if upgrade.get('status')!='waiting-exit' or upgrade.get('manifest')!=request['manifest']:
        raise ValueError('Verified upgrade is not waiting')
    node=Path(old['executable']).parent/'resources/cua_node/bin/node.exe'
    adapter=DesktopAdapter(str(node),ROOT,True)
    revisions={};proven={target};idle_samples=0
    write_status('waiting-reply',threadId=target,build=new['build'][:12])
    try:
        deadline=time.monotonic()+1800
        while time.monotonic()<deadline:
            waiting=False
            ids=set(request.get('watchThreads',[]))|set(phone_threads())|{target}
            for tid in ids:
                try:
                    uuid.UUID(tid)
                    state=await adapter.call('snapshot',tid,knownRevision=revisions.get(tid))
                    proven.add(tid);revisions[tid]=state.get('revision')
                    waiting=busy(state) or waiting
                except Exception:
                    # An unloaded chat has no owner. Loss of an observed owner
                    # cannot prove that it is safe to stop its process.
                    if tid in proven:raise
            idle_samples=0 if waiting else idle_samples+1
            if idle_samples>=3:break
            await asyncio.sleep(3)
        else:raise TimeoutError('Desktop did not become idle; left running')
        await adapter.close()
        # Recheck pointers immediately before the authorized, scoped stop.
        if json.loads((ROOT/'runtime/shared-desktop.json').read_text())['manifest']!=request['previousManifest']:
            raise ValueError('Desktop changed while waiting; left running')
        write_status('restarting',threadId=target,build=new['build'][:12])
        stop_project_host()
        write_status('waiting-upgrade',threadId=target,build=new['build'][:12])
        deadline=time.monotonic()+240
        while time.monotonic()<deadline:
            pointer=json.loads((ROOT/'runtime/shared-desktop.json').read_text())
            if pointer.get('manifest')==request['manifest']:
                try:
                    capabilities=await adapter.call('capabilities',None)
                    if capabilities.get('planMode') is True and all(capabilities.get(name) is True for name in request.get('requiredCapabilities', [])):break
                except Exception:pass
            await asyncio.sleep(3)
        else:raise TimeoutError('New desktop readiness not confirmed')
        await request_open(target)
        deadline=time.monotonic()+90
        while time.monotonic()<deadline:
            try:
                state=await adapter.call('snapshot',target)
                if state.get('planMode') is True and state.get('threadId')==target:
                    write_status('ready',threadId=target,build=new['build'][:12]);return
            except Exception:pass
            await asyncio.sleep(3)
        raise TimeoutError('Original conversation reconnection not confirmed')
    finally:await adapter.close()


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--request',type=Path,required=True)
    args=parser.parse_args();file=args.request.resolve()
    try:
        if file.parent!=(ROOT/'runtime').resolve():raise ValueError('Restart request outside runtime')
        asyncio.run(restart(json.loads(file.read_text(encoding='utf-8'))))
    except BaseException as error:
        write_status('failed',reason=str(error)[:250]);raise
