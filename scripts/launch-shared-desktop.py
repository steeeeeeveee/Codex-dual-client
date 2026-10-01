"""Start only the verified compatible desktop, preserving the user's Codex home."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

ROOT=Path(__file__).resolve().parents[1]

def load_manifest():
    pointer=json.loads((ROOT/'runtime/shared-desktop.json').read_text(encoding='utf-8'))
    file=Path(pointer['manifest']).resolve()
    parent=(ROOT/'runtime/desktop-shared').resolve()
    if parent not in file.parents:raise RuntimeError('Desktop manifest outside project')
    m=json.loads(file.read_text(encoding='utf-8'))
    executable=Path(m['executable']).resolve()
    if executable != file.parent/'app/ChatGPT.exe':raise RuntimeError('Unexpected desktop executable')
    if hashlib.sha256(executable.read_bytes()).hexdigest()!=m['executableDigest']:raise RuntimeError('Desktop build changed; launch paused')
    with (executable.parent/'resources/app.asar').open('rb') as f:
        import struct
        prefix=f.read(16);length=struct.unpack_from('<I',prefix,12)[0]
        if length>32*1024*1024 or hashlib.sha256(f.read(length)).hexdigest()!=m['archiveDigest']:raise RuntimeError('Desktop archive changed; launch paused')
    return m

def launch(thread=None, lab_home=None, lab_profile=None):
    if thread and not re.fullmatch(r'[0-9a-f-]{36}',thread):raise ValueError('Invalid thread ID')
    m=load_manifest()
    home=str(Path(lab_home).resolve()) if lab_home else m['codexHome']
    profile=str(Path(lab_profile).resolve()) if lab_profile else m['profile']
    if lab_home and (ROOT/'runtime').resolve() not in Path(home).parents:raise ValueError('Lab home outside runtime')
    if lab_profile and (ROOT/'runtime').resolve() not in Path(profile).parents:raise ValueError('Lab profile outside runtime')
    env={k:v for k,v in os.environ.items() if not k.startswith('CODEX_') and k not in ('NODE_OPTIONS','ELECTRON_RUN_AS_NODE')}
    env.update(CODEX_HOME=home,CODEX_ELECTRON_USER_DATA_PATH=profile,CODEX_MOBILE_SHARED_DESKTOP='1',
        CODEX_MOBILE_MEDIA_ROOT=str(ROOT/'runtime/media'),
        CODEX_CLI_PATH=str(Path(m['executable']).parent/'resources/codex.exe'),
        HTTP_PROXY='http://127.0.0.1:7897',HTTPS_PROXY='http://127.0.0.1:7897',NO_PROXY='127.0.0.1,localhost')
    args=[m['executable'],'--no-error-dialogs','--user-data-dir='+profile]
    if thread:args.append('codex://threads/'+thread)
    # This is the user-facing desktop, not a background helper. SW_HIDE can
    # leave Electron alive with no visible window on Windows.
    start=subprocess.STARTUPINFO();start.dwFlags|=subprocess.STARTF_USESHOWWINDOW;start.wShowWindow=1
    return subprocess.Popen(args,env=env,cwd=m['base'],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,
        creationflags=subprocess.CREATE_NO_WINDOW,startupinfo=start)

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--thread');p.add_argument('--lab-home');p.add_argument('--lab-profile');a=p.parse_args()
    child=launch(a.thread,a.lab_home,a.lab_profile)
    print(json.dumps({'pid':child.pid,'compatibleDesktop':True}))
