"""Isolated visual scenes; every business POST is rejected, no real backend."""
import json
import time
from http.server import ThreadingHTTPServer
from urllib.parse import urlsplit
from preview_server import Handler, ROOT

SCENE='new'
TID='fixture-ui-visual'
TEXT='''可以，我们可以先确定你喜欢的视觉方向。

**简洁的界面，让内容成为主角。**

1. 用白色背景和宽松留白呈现对话。
2. 把历史记录收进侧栏，聊天更专注。
3. 模型和计划模式放在输入框附近，随时可用。

| 页面 | 设计重点 |
|---|---|
| 登录 | 标志、口令、一个按钮 |
| 对话 | 自然阅读，清晰排版 |
| 选择题 | 直观的选项与确认 |

行内公式：\\(E=mc^2\\)。代码也可以保留高亮和复制：

```js
const message = '你好，Codex';
console.log(message);
```
'''

def state():
    thinking=SCENE=='thinking'
    pending=SCENE=='questions'
    offline=SCENE in ('offline','pending')
    question={'clientRequestId':'fixture-question','method':'mobile/asyncQuestion','params':{'threadId':TID,'turnId':'fixture-turn','questions':[
        {'id':'style','question':'你希望页面给人的第一感觉是什么？','isOther':True,'options':[{'label':'简洁、自然（推荐）','description':'白色背景，重点放在聊天内容。'},{'label':'活泼、有个性','description':'使用更多色彩和视觉元素。'}]},
        {'id':'priority','question':'哪个页面最值得先完善？','isOther':True,'options':[{'label':'聊天页面','description':'先优化每天最常使用的部分。'},{'label':'登录页面','description':'先完善进入工具时的体验。'}]}]}}
    turns=[{'id':'old','status':'completed','items':[{'id':'user-old','type':'userMessage','content':[{'type':'text','text':'我们把这个页面做得更简洁一些吧。'}]},{'id':'reply-old','type':'agentMessage','text':TEXT}]},
        {'id':'fixture-turn','status':'inProgress' if thinking or pending else 'completed','items':[{'id':'user-now','type':'userMessage','content':[{'type':'text','text':'可以，保留所有功能，参考手机聊天的布局。'}]},{'id':'reply-now','type':'agentMessage','text':'我会保留现有功能，并把常用操作放在更顺手的位置。' if not pending else '先确认两个小问题，再给出完整方案。'}]}]
    if SCENE=='plan':turns[-1]['items'][-1]={'id':'plan','type':'plan','text':'## 最终方案\n\n**保留现有功能，统一视觉。**\n\n1. 登录页只保留标志与口令。\n2. 聊天页面使用白底。\n3. 历史与额度收进侧栏。'}
    settings={'version':'demo:1','next':{'model':'demo-model','effort':'medium','mode':'plan' if pending or SCENE=='plan' else 'default'},'current':{'model':'demo-model','effort':'medium','mode':'default'} if thinking else None}
    return dict(mode='shared',serviceMode='shared',threadId=TID,thread=dict(id=TID,name='手机界面设计',turns=turns),turnId='fixture-turn' if thinking or pending else None,desktop={'connected':not offline,'reason':'等待电脑连接'},planMode=True,settings=settings,pending=[question] if pending else [],queue=[],outbox=[{'id':'waiting','text':'等待电脑转交的内容','status':'needs-review'}] if offline else [],canOpenDesktop=offline,
                turnControl={'supported':True,'canPause':thinking,'resumableTurnId':None},planReview={'id':'fixture-plan','turnId':'fixture-turn','text':turns[-1]['items'][-1]['text']} if SCENE=='plan' else None)

class UIHandler(Handler):
    def do_GET(self):
        global SCENE
        path=urlsplit(self.path).path
        if path in ('/login','/new','/chat','/questions','/thinking','/offline','/pending','/plan','/keyboard','/drawer'):
            SCENE='chat' if path=='/drawer' else path[1:]
            html=(ROOT/'static/index.html').read_text(encoding='utf-8').replace('<html lang="zh-CN">','<html lang="zh-CN" data-scene="'+SCENE+'">').replace('<script type="module" src="/static/app.js', '<script type="module" src="/tests/fixtures/ui-seed.mjs"></script><script type="module" src="/static/app.js')
            if path=='/drawer':
                html=html.replace('</head>','<script type="module" src="/tests/fixtures/drawer-scene.mjs"></script></head>')
            body=html.encode();self.send_response(200);self.send_header('Content-Type','text/html; charset=utf-8');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body);return
        if path.startswith('/api/') and SCENE=='login':
            self.send_response(401);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(b'{"detail":"Login required"}');return
        if path=='/api/state':return self.json(state())
        if path=='/api/threads':return self.json({'data':[{'id':TID,'name':'手机界面设计'},{'id':'fixture-two','name':'周末旅行计划'},{'id':'fixture-three','name':'学习笔记与数学公式'},{'id':'fixture-four','name':'新项目的初步想法'},{'id':'fixture-five','name':'怎样把一个复杂问题解释清楚'},{'id':'fixture-six','name':'代码与表格排版'}]})
        if path=='/api/threads/requests':return self.json({'data':[{'requestId':'fixture-create','target':{'type':'projectless'},'text':'一条等待电脑创建的消息','status':'waiting'}] if SCENE=='pending' else []})
        if path.startswith('/api/thread/'):return self.json({'mode':'shared','thread':state()['thread']})
        if path=='/api/capabilities':return self.json({'desktop':{'connected':SCENE not in ('offline','pending')},'planMode':True,'create':True,'settings':True,'usage':True,'models':[{'id':'demo-model','name':'GPT-6 Sol','defaultEffort':'medium','efforts':[{'id':'low'},{'id':'medium'},{'id':'high'}]},{'id':'demo-other','name':'GPT-6 Astra','defaultEffort':'high','efforts':[{'id':'medium'},{'id':'high'}]}],'projects':[{'id':'demo-project','name':'我的项目'}]})
        if path=='/api/usage':
            now=time.time();return self.json({'status':'stale' if SCENE=='offline' else 'fresh','reason':'desktop-offline' if SCENE=='offline' else None,'fetchedAt':now,'windows':{'fiveHour':{'remainingPercent':82,'resetsAt':int(now+7200)},'weekly':None if SCENE=='offline' else {'remainingPercent':64,'resetsAt':int(now+86400*3)}}})
        if path=='/api/events':
            self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
            try:
                for _ in range(120):
                    data={'threadId':TID,'connected':True,'nickname':'Codex','turns':state()['thread']['turns'],'settings':state()['settings']}
                    self.wfile.write(('event: transcript\ndata: '+json.dumps(data,ensure_ascii=False)+'\n\n').encode());self.wfile.flush();time.sleep(2)
            except ConnectionError:pass
            return
        return super().do_GET()

if __name__=='__main__':ThreadingHTTPServer(('127.0.0.1',8772),UIHandler).serve_forever()
