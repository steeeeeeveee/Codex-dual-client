"""Loopback-only Plan UI demonstration. No production state or write endpoints."""
import json
import time
from urllib.parse import urlsplit
from http.server import ThreadingHTTPServer
from preview_server import Handler
STAGE='questions'
TID='fixture-plan-only'
TEXT='## 实施方案\n\n1. 先回答真实问题，明确需求。\n2. 核对最终方案与验收条件。\n3. 点击采用后，由电脑开始执行。'
SETTINGS={'version':'demo:1','next':{'model':'demo','effort':'medium','mode':'plan'},'current':None}
def state():
    question=STAGE=='questions'
    turn={'id':'demo-turn','status':'inProgress' if question else 'completed','items':[{'id':'a','type':'agentMessage' if question else 'plan','text':'先确定范围，再给出最终方案。' if question else TEXT}]}
    return {'mode':'shared','serviceMode':'shared','threadId':TID,'thread':{'id':TID,'name':'计划模式交互演示（仅本机样例）','turns':[turn]},'turnId':'demo-turn' if question else None,'desktop':{'connected':True},'planMode':True,'settings':SETTINGS,'queue':[],'outbox':[],
       'pending':[{'clientRequestId':'sample-question-token','method':'mobile/asyncQuestion','params':{'threadId':TID,'turnId':'demo-turn','questions':[{'id':'sample-question','question':'第一版希望在哪个范围内使用？','isOther':True,'options':[{'label':'仅自己使用（推荐）','description':'沿用目前的私人网页和电脑连接。'},{'label':'与家人一起使用','description':'需要进一步讨论账户与权限。'}]}]}}] if question else [],
       'planReview':None if question else {'id':'demo-plan','turnId':'demo-turn','text':TEXT}}
class PlanHandler(Handler):
    def do_GET(self):
        global STAGE
        path=urlsplit(self.path).path
        if path in ('/questions','/plan'):
            STAGE=path[1:] if path=='/questions' else 'plan';self.path='/static/index.html';return super().do_GET()
        if path=='/api/state':return self.json(state())
        if path=='/api/threads':return self.json({'data':[{'id':TID,'name':'计划模式交互演示（仅本机样例）'}]})
        if path=='/api/threads/requests':return self.json({'data':[]})
        if path.startswith('/api/thread/'):return self.json({'mode':'shared','thread':state()['thread']})
        if path=='/api/capabilities':return self.json({'desktop':{'connected':True},'planMode':True,'settings':True,'create':True,'projects':[],'models':[{'id':'demo','name':'示例模型','defaultEffort':'medium','efforts':[{'id':'medium'}]}]})
        if path=='/api/events':
            data={'threadId':TID,'connected':True,'nickname':'Codex','turns':state()['thread']['turns']}
            self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
            try:
                for _ in range(180):
                    self.wfile.write(('event: transcript\ndata: '+json.dumps(data,ensure_ascii=False)+'\n\n').encode());self.wfile.flush();time.sleep(2)
            except ConnectionError:pass
            return
        return super().do_GET()
if __name__=='__main__':ThreadingHTTPServer(('127.0.0.1',8770),PlanHandler).serve_forever()
