import asyncio
import json
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock
from shared_queue import DesktopAdapter, SharedQueue


class StreamingTests(unittest.IsolatedAsyncioTestCase):
    async def test_interleaved_events_do_not_consume_rpc_response(self):
        adapter = DesktopAdapter('', None)
        events = []
        adapter.on_event = events.append
        future = asyncio.get_running_loop().create_future()
        adapter.pending['request'] = future
        reader = asyncio.StreamReader()
        reader.feed_data((json.dumps({'event':'transcript','threadId':'one'})+'\n'+
                          json.dumps({'id':'request','result':{'queue':[]}})+'\n').encode())
        reader.feed_eof()
        await adapter.read_events(SimpleNamespace(stdout=reader))
        self.assertEqual((await future)['result'], {'queue':[]})
        self.assertEqual(events[0]['threadId'], 'one')
        self.assertEqual(events[-1]['event'], 'disconnected')

    async def test_disconnect_rejects_pending_rpc(self):
        adapter = DesktopAdapter('', None)
        future = asyncio.get_running_loop().create_future()
        adapter.pending['request'] = future
        reader = asyncio.StreamReader()
        reader.feed_eof()
        await adapter.read_events(SimpleNamespace(stdout=reader))
        with self.assertRaisesRegex(RuntimeError, 'disconnected'):
            await future

    async def test_live_subscription_reconnect_baseline_and_cleanup(self):
        queue = SharedQueue(':memory:', AsyncMock(), {'one':'One','two':'Two'})
        stream = queue.stream('one')
        self.assertFalse((await anext(stream))['connected'])
        waiting = asyncio.create_task(anext(stream))
        await asyncio.sleep(0)
        queue.receive_stream({'threadId':'one','connected':True,'revision':1,'nickname':'Codex','turns':[{'id':'t','status':'inProgress','items':[]}]})
        self.assertTrue((await asyncio.wait_for(waiting,1))['connected'])
        queue.receive_stream({'event':'disconnected'})
        self.assertFalse(queue.live['one']['connected'])
        self.assertEqual(queue.live['one']['turns'][0]['status'],'inProgress')
        self.assertNotIn('two',queue.live)
        await stream.aclose()
        self.assertFalse(queue.listeners)
        reconnect = queue.stream('one')
        self.assertEqual((await anext(reconnect))['turns'][0]['id'],'t')
        await reconnect.aclose()
        await queue.close()
