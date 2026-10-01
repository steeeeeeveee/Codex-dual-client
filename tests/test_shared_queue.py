import asyncio
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import AsyncMock
from shared_queue import SharedQueue


class FakeDesktop:
    def __init__(self):
        self.online = True
        self.protocol = 'mobile-queue-v2'
        self.fail = None
        self.receipts = {}
        self.calls = []
        self.queue = []
        self.close = AsyncMock()

    async def call(self, operation, tid, **params):
        if not self.online:
            raise OSError('offline')
        if operation == 'snapshot':
            return dict(protocol=self.protocol,threadId=tid,queue=self.queue.copy(),pending=[],
                        thread={'id':tid,'turns':[]},receipts=[dict(messageId=k,status=v) for k,v in self.receipts.items()])
        self.calls.append(params['messageId'])
        if self.fail == 'before':
            raise OSError('unknown')
        self.receipts[params['messageId']] = 'queued'
        self.queue.append(dict(id=params['messageId'],text=params['text']))
        if self.fail == 'after':
            raise OSError('ack lost')
        return dict(messageId=params['messageId'],status='queued')


class SharedTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name)/'deliveries.sqlite'
        self.desktop = FakeDesktop()
        self.queue = SharedQueue(self.path,self.desktop,{'test':'Test'})

    async def asyncTearDown(self):
        await self.queue.close()
        self.temp.cleanup()

    async def enqueue(self, text='message'):
        mid = str(uuid.uuid4())
        await self.queue.enqueue('test',mid,text)
        return mid

    async def test_offline_restart_preserves_order_and_cancellation(self):
        self.desktop.online=False
        first,second,third = await self.enqueue('one'),await self.enqueue('two'),await self.enqueue('three')
        self.queue.cancel('test',second)
        await self.queue.sync('test')
        self.assertEqual(self.desktop.calls,[])
        await self.queue.close()
        self.queue=SharedQueue(self.path,self.desktop,{'test':'Test'})
        self.desktop.online=True
        await self.queue.sync('test')
        await self.queue.sync('test')
        self.assertEqual(self.desktop.calls,[first,third])
        with self.assertRaises(ValueError):self.queue.cancel('test',first)

    async def test_lost_receipt_reconciles_before_next_and_never_repeats(self):
        first,second=await self.enqueue('one'),await self.enqueue('two')
        self.desktop.fail='after'
        await self.queue.sync('test')
        self.assertEqual(self.desktop.calls,[first])
        self.desktop.fail=None
        await self.queue.close()
        self.queue=SharedQueue(self.path,self.desktop,{'test':'Test'})
        await self.queue.sync('test')
        self.assertEqual(self.desktop.calls,[first,second])

    async def test_unknown_blocks_later_transfer_and_cannot_cancel(self):
        first,second=await self.enqueue('one'),await self.enqueue('two')
        self.desktop.fail='before'
        await self.queue.sync('test')
        self.desktop.fail=None
        await self.queue.sync('test')
        self.assertEqual(self.desktop.calls,[first])
        self.assertEqual(self.queue.rows('test')[0]['status'],'needs-review')
        with self.assertRaises(ValueError):self.queue.cancel('test',first)
        self.queue.cancel('test',second)

    async def test_concurrent_retries_and_different_content(self):
        mid=str(uuid.uuid4())
        await asyncio.gather(*(self.queue.enqueue('test',mid,'same') for _ in range(20)))
        with self.assertRaises(ValueError):await self.queue.enqueue('test',mid,'other')
        await self.queue.sync('test')
        self.assertEqual(self.desktop.calls,[mid])

    async def test_incompatible_keeps_saved_messages(self):
        mid=await self.enqueue()
        self.desktop.protocol='unknown'
        await self.queue.sync('test')
        state=self.queue.state('test')
        self.assertFalse(state['desktop']['connected'])
        self.assertEqual(state['outbox'][0]['status'],'waiting')
        self.assertEqual(self.desktop.calls,[])
        self.queue.cancel('test',mid)

    async def test_desktop_edit_delete_reorder_and_version(self):
        first,second=await self.enqueue('one'),await self.enqueue('two')
        await self.queue.sync('test');await self.queue.sync('test')
        version=self.queue.state('test')['version']
        self.desktop.queue.reverse();self.desktop.queue[0]['text']='edited'
        await self.queue.sync('test')
        self.assertEqual(self.queue.state('test')['queue'][0]['text'],'edited')
        self.assertNotEqual(self.queue.state('test')['version'],version)
        self.desktop.queue=[];self.desktop.receipts={first:'accepted-earlier',second:'executed'}
        await self.queue.sync('test')
        self.assertEqual(self.desktop.calls,[first,second])
        self.assertEqual(self.queue.state('test')['queue'],[])

    async def test_cancel_while_another_append_is_in_flight(self):
        first,second=await self.enqueue('one'),await self.enqueue('two')
        original=self.desktop.call
        async def call(operation,tid,**params):
            if operation=='append' and params['messageId']==first:
                self.queue.cancel('test',second)
            return await original(operation,tid,**params)
        self.desktop.call=call
        await self.queue.sync('test')
        self.assertEqual(self.desktop.calls,[first])

    async def test_plan_and_unapproved_thread_rejected(self):
        with self.assertRaises(ValueError):await self.queue.enqueue('test',str(uuid.uuid4()),'hello',True)
        with self.assertRaises(ValueError):await self.queue.enqueue('other',str(uuid.uuid4()),'hello')

    async def test_all_local_catalog_and_offline_messages_survive_restart(self):
        await self.queue.close()
        self.queue=SharedQueue(self.path,self.desktop,{},all_local=True)
        first,other=str(uuid.uuid4()),str(uuid.uuid4())
        self.queue.register(first,'First');self.queue.register(other,'Other')
        mid=str(uuid.uuid4());await self.queue.enqueue(first,mid,'offline')
        self.desktop.online=False;await self.queue.sync(first)
        await self.queue.close()
        self.queue=SharedQueue(self.path,self.desktop,{},all_local=True)
        self.assertFalse(self.queue.state(first)['desktop']['connected'])
        self.assertTrue(self.queue.state(first)['canOpenDesktop'])
        self.assertEqual(self.queue.rows(other),[])
        self.assertEqual(self.queue.rows(first)[0]['id'],mid)
        self.desktop.online=True;await self.queue.sync(first)
        self.assertEqual(self.desktop.calls,[mid])

    async def test_unchanged_history_keeps_cached_content_and_new_queue(self):
        self.desktop.call=AsyncMock(side_effect=[
            dict(protocol='mobile-queue-v2',threadId='test',revision='epoch:1',queue=[],pending=[],receipts=[],thread={'id':'test','turns':[{'id':'old'}]}),
            dict(protocol='mobile-queue-v2',threadId='test',revision='epoch:1',queue=[{'id':'new'}],pending=[],receipts=[])])
        await self.queue.sync('test');await self.queue.sync('test')
        self.assertEqual(self.queue.state('test')['thread']['turns'],[{'id':'old'}])
        self.assertEqual(self.queue.state('test')['queue'],[{'id':'new'}])
        self.assertEqual(self.desktop.call.call_args.kwargs['knownRevision'],'epoch:1')

    async def test_existing_writer_keeps_unsent_message_waiting(self):
        await self.enqueue()
        self.desktop.call=AsyncMock(side_effect=RuntimeError('Desktop conversation not resumed; waiting for writer'))
        await self.queue.sync('test')
        self.assertFalse(self.queue.state('test')['desktop']['connected'])
        self.assertEqual(self.queue.rows('test')[0]['status'],'waiting')
        self.assertIn('旧桌面',self.queue.state('test')['desktop']['reason'])

    async def test_connection_probe_never_transfers_a_waiting_message(self):
        await self.enqueue()
        self.assertTrue((await self.queue.probe('test'))['connected'])
        self.assertEqual(self.desktop.calls,[])
        self.assertEqual(self.queue.rows('test')[0]['status'],'waiting')

    async def test_original_owner_and_original_open_are_distinct(self):
        await self.enqueue()
        for error,code in [('Original desktop owns conversation','original-owner'),('Original desktop running; compatible owner unavailable','original-open')]:
            self.desktop.call=AsyncMock(side_effect=RuntimeError(error))
            state=await self.queue.probe('test')
            self.assertFalse(state['connected']);self.assertEqual(state['code'],code)
            self.assertEqual(self.queue.rows('test')[0]['status'],'waiting')
