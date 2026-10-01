"""Separate loopback UI acceptance server; does not change production config."""
import json
import os
from pathlib import Path
import sys
from windows_job import contain_process_tree

root = Path(__file__).resolve().parents[1]
manifest = json.loads(Path(sys.argv[1]).read_text())
base = Path(manifest['base'])
config = dict(password='phone-queue-ui-test', origins=['http://127.0.0.1:8768'],
    sharedOnly=True, codex=str(Path(manifest['sourceInstallation'])/'app/resources/codex.exe'),
    sharedLab=dict(node=str(Path(manifest['sourceInstallation'])/'app/resources/cua_node/bin/node.exe'),
        threads={manifest['threadId']:'共享队列 · 独立验收对话'}))
config_path=base/'mobile-test-config.json'
config_path.write_text(json.dumps(config),encoding='utf-8')
os.environ['MOBILE_CONFIG']=str(config_path)
os.environ['MOBILE_DB']=str(base/'mobile-test.sqlite')
sys.path.insert(0,str(root))
os.chdir(root)
contain_process_tree()
import uvicorn
uvicorn.run('app:app',host='127.0.0.1',port=8768,access_log=False)
