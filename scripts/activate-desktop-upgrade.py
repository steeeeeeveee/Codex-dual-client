"""Activate a verified staged build after the old desktop exits naturally.

This never stops a process or a running task. Task Scheduler keeps this small
one-shot helper alive independently of the desktop that requested the upgrade.
"""
import argparse
import asyncio
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import time

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from desktop_launch import request_open
from shared_queue import DesktopAdapter


def write_json(path,value):
    temporary=path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value,ensure_ascii=False,indent=2),encoding='utf-8')
    temporary.replace(path)


def desktop_running(executable):
    result=subprocess.run(['powershell.exe','-NoProfile','-NonInteractive','-Command',
        'Get-CimInstance Win32_Process -Filter "Name=\'ChatGPT.exe\'" | Select-Object ExecutablePath | ConvertTo-Json -Compress'],
        capture_output=True,text=True,timeout=20,creationflags=subprocess.CREATE_NO_WINDOW,check=True)
    processes=json.loads(result.stdout.strip() or '[]')
    if isinstance(processes,dict):processes=[processes]
    # Inaccessible executable paths cannot prove that the old desktop has exited.
    return any(not p.get('ExecutablePath') or Path(p['ExecutablePath']).resolve()==executable for p in processes)


async def activate(manifest_file,thread_id):
    parent=(ROOT/'runtime/desktop-shared').resolve()
    manifest_file=manifest_file.resolve()
    if parent not in manifest_file.parents or manifest_file.name!='manifest.json':raise ValueError('Invalid staged desktop')
    manifest=json.loads(manifest_file.read_text(encoding='utf-8'))
    pointer=ROOT/'runtime/shared-desktop.json'
    previous=json.loads(pointer.read_text(encoding='utf-8'))
    old=json.loads(Path(previous['manifest']).read_text(encoding='utf-8'))
    old_executable=Path(old['executable']).resolve()
    state_file=ROOT/'runtime/desktop-upgrade.json'
    state={'status':'waiting-exit','manifest':str(manifest_file),'previous':previous,'build':manifest['build'][:12]}
    write_json(state_file,state)
    deadline=time.monotonic()+24*3600
    while desktop_running(old_executable):
        if time.monotonic()>deadline:
            state.update(status='expired');write_json(state_file,state);return
        await asyncio.sleep(3)
    if json.loads(pointer.read_text(encoding='utf-8'))!=previous:raise RuntimeError('Desktop pointer changed during upgrade')
    write_json(ROOT/'runtime/shared-desktop.before-compose.json',previous)
    write_json(pointer,{'manifest':str(manifest_file)})
    spec=importlib.util.spec_from_file_location('shared_launcher',ROOT/'scripts/launch-shared-desktop.py')
    launcher=importlib.util.module_from_spec(spec);spec.loader.exec_module(launcher)
    try:launcher.load_manifest()  # Verify executable and archive before launching.
    except BaseException:
        write_json(pointer,previous);raise
    state.update(status='launching');write_json(state_file,state)
    await request_open(thread_id)
    node=Path(manifest['executable']).parent/'resources/cua_node/bin/node.exe'
    adapter=DesktopAdapter(str(node),ROOT,True)
    try:
        for _ in range(40):
            try:
                result=await adapter.call('capabilities',None)
                if result.get('protocol')=='mobile-compose-v1':
                    state.update(status='ready');write_json(state_file,state);return
            except Exception:pass
            await asyncio.sleep(3)
        raise RuntimeError('New desktop did not confirm creation capability')
    finally:await adapter.close()


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--manifest',type=Path,required=True);parser.add_argument('--thread')
    args=parser.parse_args()
    try:asyncio.run(activate(args.manifest,args.thread))
    except Exception as exc:
        path=ROOT/'runtime/desktop-upgrade.json'
        state=json.loads(path.read_text(encoding='utf-8')) if path.exists() else {}
        state.update(status='failed',reason=str(exc));write_json(path,state)
        raise
