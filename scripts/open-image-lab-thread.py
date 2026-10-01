"""Send a deep link only to the verified disposable image acceptance desktop."""
import json
import os
from pathlib import Path
import subprocess
import sys
import uuid

root=Path(__file__).resolve().parents[1]
file=Path(sys.argv[1]).resolve()
if file.parent.parent!=(root/'runtime/desktop-prototype').resolve() or file.name!='manifest.json':
    raise ValueError('Isolated desktop manifest required')
manifest=json.loads(file.read_text(encoding='utf-8'))
tid=str(uuid.UUID(sys.argv[2]))
executable=Path(manifest['executable']).resolve()
if executable!=file.parent/'app/ChatGPT.exe':raise ValueError('Unexpected lab executable')
env={key:value for key,value in os.environ.items() if not key.startswith('CODEX_')}
env.update(CODEX_ELECTRON_USER_DATA_PATH=manifest['profile'],CODEX_HOME=manifest['codexHome'],
    CODEX_MOBILE_LAB_THREAD_ID='*',CODEX_MOBILE_MEDIA_ROOT=str(root/'runtime/media'),
    CODEX_CLI_PATH=str(Path(manifest['sourceInstallation'])/'app/resources/codex.exe'))
startup=subprocess.STARTUPINFO();startup.dwFlags|=subprocess.STARTF_USESHOWWINDOW;startup.wShowWindow=0
subprocess.run([str(executable),'--user-data-dir='+manifest['profile'],'codex://threads/'+tid],
    cwd=file.parent,env=env,startupinfo=startup,creationflags=subprocess.CREATE_NO_WINDOW,
    stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=20,check=True)
