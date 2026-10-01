"""Bounded multi-chat acceptance desktop, using the deployed build but a separate Codex home."""
import importlib.util
import json
from pathlib import Path
import sys
import time
from windows_job import contain_process_tree

root=Path(__file__).resolve().parents[1]
m=json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
spec=importlib.util.spec_from_file_location('shared_launcher',root/'scripts/launch-shared-desktop.py')
launcher=importlib.util.module_from_spec(spec);spec.loader.exec_module(launcher)
contain_process_tree()
stop=root/'runtime/shared-check-stop'
if stop.exists():stop.unlink()
child=launcher.launch(m['threadId'],m['codexHome'],str(root/'runtime/desktop-shared/check-profile'))
print(json.dumps({'pid':child.pid,'sharedBuildLab':True}),flush=True)
deadline=time.monotonic()+900
while child.poll() is None and time.monotonic()<deadline and not stop.exists():time.sleep(1)
if child.poll() is None:child.terminate()
child.wait(timeout=10)
