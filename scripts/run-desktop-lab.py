"""Run the disposable lab with a bounded lifetime and process-tree cleanup."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from windows_job import contain_process_tree

manifest_path = Path(sys.argv[1]).resolve()
manifest = json.loads(manifest_path.read_text())
base = Path(manifest['base'])
if base != manifest_path.parent or base.parent.name != 'desktop-prototype':
    raise RuntimeError('Expected isolated lab manifest')
env = {key: value for key, value in os.environ.items() if not key.startswith('CODEX_')}
env.pop('NODE_OPTIONS', None)
env.pop('ELECTRON_RUN_AS_NODE', None)
env.update(CODEX_ELECTRON_USER_DATA_PATH=manifest['profile'], CODEX_HOME=manifest['codexHome'],
    CODEX_MOBILE_LAB_THREAD_ID='*' if manifest.get('allLocal') else manifest['threadId'],
    CODEX_MOBILE_MEDIA_ROOT=str(Path(__file__).resolve().parents[1]/'runtime/media'),
    CODEX_CLI_PATH=str(Path(manifest['sourceInstallation']) / 'app/resources/codex.exe'),
    HTTP_PROXY='http://127.0.0.1:7897', HTTPS_PROXY='http://127.0.0.1:7897', NO_PROXY='127.0.0.1,localhost')
contain_process_tree()
startup = subprocess.STARTUPINFO()
startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
startup.wShowWindow = 0
with (base / 'desktop-stdout.log').open('ab') as out, (base / 'desktop-stderr.log').open('ab') as err:
    child = subprocess.Popen([manifest['executable'], '--no-error-dialogs', '--enable-logging=stderr',
        '--user-data-dir=' + manifest['profile'], 'codex://threads/' + manifest['threadId']],
        cwd=base, env=env, stdout=out, stderr=err, startupinfo=startup,
        creationflags=subprocess.CREATE_NO_WINDOW)
    print(json.dumps({'pid': child.pid, 'labPipe': manifest['pipe'], 'threadId': manifest['threadId']}), flush=True)
    lifetime = int(sys.argv[2]) if len(sys.argv)>2 else 600
    if not 60 <= lifetime <= 1800:raise ValueError('Lab lifetime must be 60 to 1800 seconds')
    deadline = time.monotonic() + lifetime
    while child.poll() is None and time.monotonic() < deadline and not (base / 'stop-lab').exists():
        time.sleep(1)
    if child.poll() is None:
        child.terminate()
    print(json.dumps({'exitCode': child.wait(timeout=10)}))
