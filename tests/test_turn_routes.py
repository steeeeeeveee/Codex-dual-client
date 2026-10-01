import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock
from fastapi import FastAPI
from fastapi.testclient import TestClient
from turn_routes import register_turn_routes


class TurnRouteTests(unittest.TestCase):
    def setUp(self):
        self.shared = SimpleNamespace(enabled=lambda tid: tid == 'chat',
            adapter=SimpleNamespace(call=AsyncMock(return_value={'status':'paused'})),
            probe=AsyncMock())
        application = FastAPI()
        register_turn_routes(application, self.shared, AsyncMock())
        self.client = TestClient(application)

    def test_expected_turn_and_conversation_are_forwarded_without_executor(self):
        response = self.client.post('/api/turn/pause', json={'threadId':'chat','turnId':'a'})
        self.assertEqual(response.status_code, 200)
        self.shared.adapter.call.assert_awaited_once_with('pause-turn','chat',turnId='a')
        self.shared.probe.assert_awaited_once_with('chat')

    def test_resume_is_distinct_and_stale_errors_remain_visible(self):
        self.shared.adapter.call.side_effect = RuntimeError('暂停任务已改变，请刷新')
        response = self.client.post('/api/turn/resume', json={'threadId':'chat','turnId':'a'})
        self.assertEqual(response.status_code, 409)
        self.assertIn('暂停任务已改变',response.json()['detail'])
        self.shared.probe.assert_not_awaited()

    def test_unshared_thread_cannot_reach_owner(self):
        self.assertEqual(self.client.post('/api/turn/pause',json={'threadId':'other','turnId':'a'}).status_code,409)
        self.shared.adapter.call.assert_not_awaited()
