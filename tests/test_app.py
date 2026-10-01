import asyncio
import json
import sqlite3
import unittest
from unittest.mock import AsyncMock, patch
from fastapi.testclient import TestClient
import app
from shared_queue import SharedQueue
import uuid

class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.real_bridge, self.real_db, self.real_shared = app.bridge, app.db, app.shared
        app.shared=SharedQueue(':memory:',AsyncMock(),{'shared-test':'Test'})
        app.bridge = app.Bridge()
        app.db = sqlite3.connect(':memory:', check_same_thread=False)
        app.db.execute('CREATE TABLE deliveries (id TEXT PRIMARY KEY,digest TEXT,status TEXT,result TEXT)')
        app.sessions.clear(); app.attempts.clear()
        self.client = TestClient(app.app, base_url='http://127.0.0.1:8767')
        self.headers = {'origin':'http://127.0.0.1:8767','x-mobile-client':'1'}
        self.client.headers.update(self.headers)
        self.client.post('/api/login',json={'password':app.cfg['password']})
        self.audit_patch=patch('app.audit');self.audit_patch.start()

    def tearDown(self):
        app.db.close();app.shared.db.close();app.shared=self.real_shared;app.db=self.real_db;app.bridge=self.real_bridge;self.audit_patch.stop()

    def test_authentication_and_cookie(self):
        self.client.cookies.clear()
        self.assertEqual(self.client.get('/api/state').status_code,401)
        response=self.client.post('/api/login',json={'password':app.cfg['password']})
        self.assertIn('HttpOnly',response.headers['set-cookie'])
        self.assertIn('SameSite=strict',response.headers['set-cookie'])
        self.assertEqual(self.client.get('/api/state').status_code,200)

    def test_usage_is_authenticated_and_has_an_independent_connection(self):
        self.assertIsNot(app.usage.adapter, self.real_shared.adapter)
        self.client.cookies.clear()
        self.assertEqual(self.client.get('/api/usage').status_code,401)
        self.client.post('/api/login',json={'password':app.cfg['password']})
        with patch.object(app.usage,'get',AsyncMock(return_value={'status':'unavailable','windows':{}})) as get:
            response=self.client.get('/api/usage?refresh=true')
        self.assertEqual(response.status_code,200)
        self.assertEqual(response.headers['cache-control'],'no-store')
        get.assert_awaited_once_with(True)

    def test_stream_requires_login_and_stops_after_logout(self):
        self.client.cookies.clear()
        self.assertEqual(self.client.get('/api/events?threadId=shared-test').status_code,401)
        self.client.post('/api/login',json={'password':app.cfg['password']})
        async def finite_stream(tid):
            yield {'threadId':tid,'connected':True,'turns':[]}
            app.sessions.clear()
            yield {'threadId':tid,'connected':True,'turns':[{'private':'must not appear'}]}
        with patch.object(app.shared,'stream',finite_stream):
            result=self.client.get('/api/events?threadId=shared-test')
        self.assertEqual(result.status_code,200)
        self.assertIn('text/event-stream',result.headers['content-type'])
        self.assertIn('event: transcript',result.text)
        self.assertNotIn('must not appear',result.text)

    def test_all_local_send_only_reads_metadata_and_saves_outbox(self):
        app.shared.all_local=True
        tid=str(uuid.uuid4())
        app.bridge.start=AsyncMock()
        app.bridge.call=AsyncMock(return_value={'thread':{'id':tid,'source':'vscode','name':'Local'}})
        response=self.client.post('/api/send',json={'id':str(uuid.uuid4()),'threadId':tid,'text':'waiting'})
        self.assertEqual(response.status_code,200,response.text)
        self.assertEqual(response.json()['status'],'waiting')
        app.bridge.call.assert_awaited_once_with('thread/read',{'threadId':tid,'includeTurns':False})
        self.assertIsNone(app.bridge.active)
        self.assertEqual(self.client.post('/api/takeover/'+tid,json={}).status_code,409)

    def test_all_local_send_rejects_noninteractive_source(self):
        app.shared.all_local=True;tid=str(uuid.uuid4())
        app.bridge.start=AsyncMock()
        for source in ['exec',{'subAgent':{'thread_spawn':{}}}]:
            app.bridge.call=AsyncMock(return_value={'thread':{'id':tid,'source':source}})
            response=self.client.post('/api/send',json={'id':str(uuid.uuid4()),'threadId':tid,'text':'blocked'})
            self.assertEqual(response.status_code,409)
            self.assertFalse(app.shared.enabled(tid))
            self.assertEqual(app.shared.rows(tid),[])

    def test_all_local_desktop_open_only_passes_validated_thread(self):
        app.shared.all_local=True;tid=str(uuid.uuid4())
        app.bridge.start=AsyncMock();app.bridge.call=AsyncMock(return_value={'thread':{'id':tid,'source':'cli'}})
        app.shared.probe=AsyncMock(return_value={'connected':False,'code':'waiting'})
        with patch('app.request_open',new_callable=AsyncMock,return_value={'ok':True,'requestId':1}) as opened:
            response=self.client.post('/api/desktop/open',json={'threadId':tid})
            self.assertEqual(response.status_code,200)
            opened.assert_awaited_once_with(tid)

    def test_connected_or_original_owned_thread_does_not_launch_another_instance(self):
        app.shared.all_local=True;tid=str(uuid.uuid4());app.shared.register(tid,'Test')
        for state,expected in [({'connected':True,'code':'connected'},200),({'connected':False,'code':'original-owner','reason':'原版占用'},409)]:
            app.shared.probe=AsyncMock(return_value=state)
            with patch('app.request_open',new_callable=AsyncMock) as opened:
                response=self.client.post('/api/desktop/open',json={'threadId':tid})
                self.assertEqual(response.status_code,expected)
                if expected==200:self.assertEqual(response.json()['status'],'connected')
                opened.assert_not_awaited()

    def test_cross_origin_and_dns_rebinding_blocked(self):
        self.assertEqual(self.client.post('/api/release',json={},headers={'origin':'https://evil.example'}).status_code,403)
        self.assertEqual(self.client.get('/api/state',headers={'host':'evil.example'}).status_code,403)

    def test_login_rate_limit(self):
        self.client.cookies.clear()
        for _ in range(10):self.client.post('/api/login',json={'password':'wrong'})
        self.assertEqual(self.client.post('/api/login',json={'password':'wrong'}).status_code,429)

    def test_duplicate_send_is_not_forwarded(self):
        app.bridge.active='existing';app.bridge.model='unchanged-model'
        app.bridge.call=AsyncMock(return_value={'turn':{'id':'t1','status':'inProgress'}})
        body={'id':'unique-message-0001','threadId':'existing','text':'hello'}
        a=self.client.post('/api/send',json=body);b=self.client.post('/api/send',json=body)
        self.assertEqual(a.status_code,200,a.text);self.assertEqual(a.json(),b.json())
        self.assertEqual(app.bridge.call.await_count,1)

    def test_unknown_send_is_not_replayed(self):
        app.bridge.active='existing';app.bridge.call=AsyncMock(side_effect=app.RpcError('timeout'))
        body={'id':'unique-message-0002','threadId':'existing','text':'hello'}
        self.assertEqual(self.client.post('/api/send',json=body).status_code,409)
        self.assertEqual(self.client.post('/api/send',json=body).status_code,409)
        self.assertEqual(app.bridge.call.await_count,1)

    def test_active_writer_is_not_forced(self):
        app.bridge.start=AsyncMock();app.bridge.call=AsyncMock(side_effect=app.RpcError('thread already has an active writer'))
        result=self.client.post('/api/takeover/existing',json={})
        self.assertEqual(result.status_code,409);self.assertIsNone(app.bridge.active)
        app.bridge.call.assert_awaited_once_with('thread/resume',{'threadId':'existing'})

    def test_cannot_release_active_turn(self):
        app.bridge.active='existing';app.bridge.turn='t1';app.bridge.close=AsyncMock()
        self.assertEqual(self.client.post('/api/release',json={}).status_code,409)
        app.bridge.close.assert_not_awaited()

    def test_real_question_shape_and_stale_answer(self):
        app.bridge.active='existing';app.bridge.write=AsyncMock()
        message={'id':501,'method':'item/tool/requestUserInput','params':{'threadId':'existing','turnId':'t1','itemId':'i1','isBlocking':True,'questions':[{'id':'choice','header':'Test','question':'Which?','options':[{'label':'First','description':'One'},{'label':'Second','description':'Two'}]}]}}
        asyncio.run(app.bridge.event(message))
        pending=self.client.get('/api/state').json()['pending']
        self.assertEqual(len(pending),1)
        client_id=pending[0]['clientRequestId']
        bad=self.client.post('/api/answer',json={'requestId':client_id,'answers':{'choice':'invalid'}})
        self.assertEqual(bad.status_code,400)
        body={'requestId':client_id,'answers':{'choice':'Second'}}
        self.assertEqual(self.client.post('/api/answer',json=body).status_code,200)
        app.bridge.write.assert_awaited_once_with({'id':501,'result':{'answers':{'choice':{'answers':['Second']}}}})
        self.assertEqual(self.client.post('/api/answer',json=body).status_code,409)

    def test_resolved_question_disappears(self):
        app.bridge.pending['3']={'id':3}
        asyncio.run(app.bridge.event({'method':'serverRequest/resolved','params':{'requestId':3}}))
        self.assertEqual(app.bridge.pending,{})

    def test_reused_rpc_id_cannot_accept_stale_approval(self):
        app.bridge.active='existing';app.bridge.write=AsyncMock()
        message={'id':0,'method':'item/commandExecution/requestApproval','params':{'threadId':'existing','turnId':'t1','itemId':'i1'}}
        asyncio.run(app.bridge.event(message));old_token=next(iter(app.bridge.pending))
        app.bridge.pending.clear()
        message['params']['turnId']='t2'
        asyncio.run(app.bridge.event(message));new_token=next(iter(app.bridge.pending))
        self.assertNotEqual(old_token,new_token)
        self.assertEqual(self.client.post('/api/answer',json={'requestId':old_token,'decision':'accept'}).status_code,409)
        app.bridge.write.assert_not_awaited()

    def test_permissions_never_expanded(self):
        msg={'method':'item/permissions/requestApproval','params':{'permissions':{'network':{'enabled':True}}}}
        result=app.answer_payload(msg,app.Answer(requestId='1',decision='accept'))
        self.assertEqual(result,{'permissions':{'network':{'enabled':True}},'scope':'turn'})
        self.assertEqual(app.answer_payload(msg,app.Answer(requestId='1',decision='decline'))['permissions'],{})

    def test_unavailable_approval_option_rejected(self):
        msg={'method':'item/commandExecution/requestApproval','params':{'availableDecisions':['decline','cancel']}}
        with self.assertRaises(app.HTTPException):app.answer_payload(msg,app.Answer(requestId='1',decision='accept'))

    def test_shared_routes_never_start_resume_or_execute_with_phone(self):
        app.bridge.start=AsyncMock();app.bridge.call=AsyncMock()
        body={'id':str(uuid.uuid4()),'threadId':'shared-test','text':'Shared'}
        self.assertEqual(self.client.post('/api/takeover/shared-test',json={}).status_code,409)
        self.assertEqual(self.client.get('/api/thread/shared-test').status_code,200)
        self.assertEqual(self.client.post('/api/send',json=body).json()['status'],'waiting')
        state=self.client.get('/api/state?threadId=shared-test').json()
        self.assertEqual(state['mode'],'shared');self.assertEqual(len(state['outbox']),1)
        self.assertEqual(self.client.post('/api/queue/cancel',json={'threadId':'shared-test','messageId':body['id']}).status_code,200)
        app.bridge.start.assert_not_called();app.bridge.call.assert_not_called()

if __name__=='__main__':unittest.main()
