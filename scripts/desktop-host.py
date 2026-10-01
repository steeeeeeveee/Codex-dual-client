"""Per-user desktop launcher. Task Scheduler separates its lifetime from either Codex app."""
import importlib.util
import json
from pathlib import Path
import sys
import time

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from desktop_launch import connect
from windows_job import contain_process_tree

spec=importlib.util.spec_from_file_location('shared_launcher',ROOT/'scripts/launch-shared-desktop.py')
launcher=importlib.util.module_from_spec(spec);spec.loader.exec_module(launcher)
contain_process_tree()
children=[]
while True:
    with connect() as db:
        requests=db.execute("SELECT id,thread FROM launches WHERE status='waiting' ORDER BY id").fetchall()
    for rid,tid in requests:
        try:
            # Pick up launcher fixes without restarting the host or its apps.
            spec.loader.exec_module(launcher)
            child=launcher.launch(tid)
            children.append(child)
            with connect() as db:db.execute("UPDATE launches SET status='launched' WHERE id=?",(rid,))
        except Exception as exc:
            with connect() as db:db.execute("UPDATE launches SET status='failed',error=? WHERE id=?",(str(exc),rid))
    children=[child for child in children if child.poll() is None]
    time.sleep(1)
