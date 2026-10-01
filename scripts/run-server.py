"""Started via pythonw; keep a small error log, no access log or prompt log."""
import os
from pathlib import Path
import sys
from windows_job import contain_process_tree
root = Path(__file__).resolve().parents[1]
os.chdir(root)
sys.path.insert(0, str(root))
contain_process_tree()
(root / 'runtime').mkdir(exist_ok=True)
sys.stdout = sys.stderr = (root / 'runtime' / 'server.log').open('a', encoding='utf-8')
import uvicorn
uvicorn.run('app:app', host='127.0.0.1', port=8767, access_log=False, proxy_headers=False)
