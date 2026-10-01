"""Read-only, loopback-only UI fixture. Never imports or calls the real backend."""
import ast
import json
from pathlib import Path
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
TREE = ast.parse((ROOT / 'app.py').read_text(encoding='utf-8'))
CSP = next(value.value for node in ast.walk(TREE) if isinstance(node, ast.Dict)
           for key, value in zip(node.keys, node.values)
           if isinstance(key, ast.Constant) and key.value == 'Content-Security-Policy')
TEXT = (ROOT / 'tests/fixtures/sample.md').read_text(encoding='utf-8')
START = None
TID = 'fixture-markdown-only'

def transcript():
    elapsed = time.monotonic() - START if START else 0
    count = min(len(TEXT), int(elapsed * 180))
    complete = count == len(TEXT)
    return {'id': 'fixture-live', 'status': 'completed' if complete else 'inProgress',
            'items': [{'id': 'fixture-agent', 'type': 'agentMessage', 'text': TEXT[:count]}]}

def thread():
    return {'id': TID, 'name': '格式与流式验收（仅本机样例）', 'turns': [
        {'id': 'fixture-history', 'status': 'completed', 'items': [
            {'id': 'fixture-user', 'type': 'userMessage', 'content': [{'type': 'text', 'text': '**用户输入保留原文**'}]},
            {'id': 'fixture-old-agent', 'type': 'agentMessage', 'text': '**历史加粗** 与 [链接](https://example.com/)\n\n\\(\\frac{a}{b}\\)'}]}, transcript()]}

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header('Content-Security-Policy', CSP)
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        super().end_headers()

    def log_message(self, *args):
        pass

    def json(self, data):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(200); self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)

    def do_GET(self):
        global START
        path = unquote(urlsplit(self.path).path)
        if path == '/api/events':
            START = START or time.monotonic()
            self.send_response(200); self.send_header('Content-Type', 'text/event-stream'); self.end_headers()
            try:
                for _ in range(260):
                    data = {'threadId': TID, 'connected': True, 'nickname': 'Codex', 'turns': [transcript()]}
                    self.wfile.write(('event: transcript\ndata: '+json.dumps(data,ensure_ascii=False)+'\n\n').encode()); self.wfile.flush()
                    if data['turns'][0]['status'] == 'completed': break
                    time.sleep(.08)
            except (BrokenPipeError, ConnectionResetError): pass
            return
        if path == '/api/state':
            active = transcript()['status'] == 'inProgress'
            return self.json({'mode':'shared','serviceMode':'shared','threadId':TID,'thread':thread(),'turnId':'fixture-live' if active else None,
                'desktop':{'connected':True},'queue':[{'id':'queued','text':'**队列仍是原文**'}],'outbox':[],'pending':[]})
        if path == '/api/threads': return self.json({'data':[{'id':TID,'name':'格式与流式验收（仅本机样例）'}]})
        if path.startswith('/api/thread/'): return self.json({'mode':'shared','thread':thread()})
        if path == '/api/threads/requests': return self.json({'data':[]})
        if path == '/api/capabilities': return self.json({'models':[],'projects':[],'desktop':{'connected':True}})
        if path == '/': self.path = '/static/index.html'; return super().do_GET()
        resolved = (ROOT / path.lstrip('/')).resolve()
        if any(path.startswith(prefix) and resolved.is_relative_to(ROOT / directory)
               for prefix,directory in [('/static/','static'),('/tests/fixtures/','tests/fixtures')]):
            return super().do_GET()
        self.send_error(404)

    def do_POST(self):
        self.send_error(405, 'This fixture cannot send or change conversations')

if __name__ == '__main__':
    ThreadingHTTPServer(('127.0.0.1', 8769), Handler).serve_forever()
