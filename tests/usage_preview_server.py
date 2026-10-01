"""Quota layout fixture: read-only and loopback-only, no real account access."""
from http.server import ThreadingHTTPServer
from urllib.parse import urlsplit
import time
from preview_server import Handler

class UsageHandler(Handler):
    def do_GET(self):
        if urlsplit(self.path).path=='/api/usage':
            now=time.time()
            return self.json(dict(status='fresh',fetchedAt=now,windows=dict(fiveHour=dict(remainingPercent=82,resetsAt=int(now+7200)),weekly=dict(remainingPercent=64,resetsAt=int(now+86400*3)))))
        return super().do_GET()

if __name__=='__main__':
    ThreadingHTTPServer(('127.0.0.1',8771),UsageHandler).serve_forever()
