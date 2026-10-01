"""Create a real disposable test conversation via App Server, in a separate home."""
import asyncio
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys


async def main():
    manifest_path = Path(sys.argv[1]).resolve()
    manifest = json.loads(manifest_path.read_text())
    base = Path(manifest['base'])
    if manifest_path.parent != base or base.parent.name != 'desktop-prototype' or (manifest.get('threadId') and '--new-test-conversation' not in sys.argv):
        raise RuntimeError('Expected unused isolated desktop lab manifest')
    if manifest.get('threadId'):
        manifest.setdefault('previousTestThreads', []).append(manifest['threadId'])
    test_home = Path(manifest['codexHome'])
    # Local copy only; never print or commit account tokens.
    shutil.copyfile(Path.home() / '.codex/auth.json', test_home / 'auth.json')
    (test_home / 'config.toml').write_text('model = "gpt-6-sol"\nmodel_reasoning_effort = "medium"\ncli_auth_credentials_store = "file"\n', encoding='utf-8')
    env = dict(os.environ)
    env.update(CODEX_HOME=str(test_home), HTTPS_PROXY='http://127.0.0.1:7897',
               HTTP_PROXY='http://127.0.0.1:7897', NO_PROXY='127.0.0.1,localhost')
    for key in list(env):
        if key.startswith('CODEX_APP_TOOLS_'):
            env.pop(key)
    cli = Path(manifest['sourceInstallation']) / 'app/resources/codex.exe'
    proc = await asyncio.create_subprocess_exec(str(cli), 'app-server', '--stdio',
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        env=env, creationflags=subprocess.CREATE_NO_WINDOW, limit=32 * 1024 * 1024)
    seq = 0
    async def call(method, params):
        nonlocal seq
        seq += 1
        proc.stdin.write((json.dumps({'id': seq, 'method': method, 'params': params}) + '\n').encode())
        await proc.stdin.drain()
        while True:
            line = await asyncio.wait_for(proc.stdout.readline(), 45)
            if not line:
                raise RuntimeError('Lab App Server disconnected')
            message = json.loads(line)
            if message.get('id') == seq and 'method' not in message:
                if 'error' in message:
                    raise RuntimeError(str(message['error']))
                return message['result']
    try:
        await call('initialize', {'clientInfo': {'name': 'codex_mobile_queue_lab', 'version': '0.1.0'},
                                 'capabilities': {'experimentalApi': True}})
        proc.stdin.write(b'{"method":"initialized"}\n')
        result = await call('thread/start', {'cwd': manifest['workspace'], 'model': 'gpt-6-sol',
            'approvalPolicy': 'never', 'sandbox': 'read-only'})
        tid = result['thread']['id']
        manifest['threadId'] = tid
        manifest_path.write_text(json.dumps(manifest, indent=2), encoding='utf-8')
        await call('turn/start', {'threadId': tid, 'input': [{'type': 'text',
            'text': '这是电脑手机共享队列的独立测试对话。不要读写文件或调用工具，现在只回复：准备就绪。'}]})
        while True:
            msg = json.loads(await asyncio.wait_for(proc.stdout.readline(), 60))
            if msg.get('method') == 'turn/completed':
                print(json.dumps({'threadId': tid, 'status': msg['params']['turn']['status'],
                    'isolatedCodexHome': str(test_home)}, ensure_ascii=False))
                break
    finally:
        proc.terminate()
        await proc.wait()


if __name__ == '__main__':
    asyncio.run(main())
