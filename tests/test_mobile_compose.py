import json
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import AsyncMock
from shared_queue import SharedQueue, DesktopUnavailable
from mobile_compose import MobileComposer


class Desktop:
    def __init__(self):
        self.online=True
        self.calls=[]
        self.receipts={}
        self.acks={}
        self.fail=None
        self.settings={'version':'one','next':{'model':'a','effort':'low'},'current':None}
        self.close=AsyncMock()

    async def call(self,operation,tid,**params):
        self.calls.append(operation)
        if not self.online:
            raise OSError('offline')
        if operation=='capabilities':
            return {'protocol':'mobile-compose-v1','projects':[],'models':[],'create':True,'settings':True}
        if operation=='create':
            if self.fail=='not-submitted':
                raise DesktopUnavailable('pipe not connected')
            if self.fail=='before':
                raise OSError('unknown')
            receipt={'status':'created','threadId':str(uuid.uuid4()),'messageId':params['messageId']}
            self.receipts[params['requestId']]=receipt
            if self.fail=='after':
                raise OSError('ack lost')
            return receipt
        if operation=='creation-status':
            return self.receipts.get(params['requestId'],{'status':'not-received'})
        if operation=='snapshot':
            return {'protocol':'mobile-queue-v2','threadId':tid,'receipts':[], 'settings':self.settings}
        if operation=='settings':
            self.settings={'version':'two','next':{'model':params['model'],'effort':params['effort']},'current':None}
            result={'status':'applied','settings':self.settings}
            self.acks[params['requestId']]=result
            if self.fail=='after':raise OSError('ack lost')
            return result
        if operation=='settings-status':return self.acks.get(params['requestId'],{'status':'not-received'})
        raise AssertionError(operation)


class ComposerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.path=Path(self.temp.name)/'test.sqlite'
        self.desktop=Desktop()
        self.open()

    def open(self):
        self.queue=SharedQueue(self.path,self.desktop,{},all_local=True)
        self.composer=MobileComposer(self.queue)

    async def asyncTearDown(self):
        await self.queue.close()
        self.temp.cleanup()

    def payload(self):
        return dict(requestId=str(uuid.uuid4()),messageId=str(uuid.uuid4()),target={'type':'projectless'},model=None,effort=None,text='hello')

    async def test_offline_cancel_and_restart_keep_creation_and_first_message_ids(self):
        self.desktop.online=False
        first,second=self.payload(),self.payload()
        self.composer.create(first);self.composer.create(second)
        await self.composer.sync()
        self.composer.cancel(second['requestId'])
        await self.queue.close();self.open();self.desktop.online=True
        await self.composer.sync();await self.composer.sync()
        self.assertEqual(self.desktop.calls.count('create'),1)
        created=self.composer.creation(first['requestId'])
        self.assertEqual(created['status'],'complete')
        self.assertEqual(self.queue.rows(created['threadId'])[0]['id'],first['messageId'])
        self.assertEqual(self.composer.creation(second['requestId'])['status'],'cancelled')

    async def test_success_with_confirmation_lost_reconciles_original_thread_after_restart(self):
        p=self.payload();self.composer.create(p);self.desktop.fail='after'
        await self.composer.sync();original=self.desktop.receipts[p['requestId']]['threadId']
        await self.queue.close();self.open();self.desktop.fail=None
        await self.composer.sync();await self.composer.sync()
        self.assertEqual(self.desktop.calls.count('create'),1)
        self.assertEqual(self.composer.creation(p['requestId'])['threadId'],original)
        self.assertEqual(len(self.queue.rows(original)),1)

    async def test_ambiguous_absent_receipt_never_replays_or_allows_cancel(self):
        p=self.payload();self.composer.create(p);self.desktop.fail='before'
        await self.composer.sync();self.desktop.fail=None
        await self.composer.sync();await self.composer.sync()
        self.assertEqual(self.desktop.calls.count('create'),1)
        self.assertEqual(self.composer.creation(p['requestId'])['status'],'needs-review')
        with self.assertRaises(ValueError):self.composer.cancel(p['requestId'])

    async def test_disconnect_proved_before_dispatch_stays_cancellable_waiting(self):
        p=self.payload();self.composer.create(p);self.desktop.fail='not-submitted'
        await self.composer.sync()
        self.assertEqual(self.composer.creation(p['requestId'])['status'],'waiting')
        self.composer.cancel(p['requestId'])

    async def test_native_initialization_failure_never_enqueues_first_message(self):
        p=self.payload();self.composer.create(p)
        self.composer.update_creation(p['requestId'],'needs-review')
        self.desktop.receipts[p['requestId']]={'status':'created','threadId':str(uuid.uuid4()),'ready':False}
        await self.composer.sync()
        self.assertEqual(self.composer.creation(p['requestId'])['status'],'needs-review')
        self.assertEqual(self.queue.db.execute('SELECT COUNT(*) FROM mobile_outbox').fetchone()[0],0)

    async def test_retry_same_id_is_idempotent_and_different_payload_or_duplicate_message_rejected(self):
        p=self.payload();self.composer.create(p);self.composer.create(p)
        with self.assertRaises(ValueError):self.composer.create({**p,'text':'changed'})
        with self.assertRaises(ValueError):self.composer.create({**p,'requestId':str(uuid.uuid4())})
        self.assertEqual(len(self.composer.creations()),1)

    async def test_created_mapping_before_first_enqueue_is_recovered_without_recreating(self):
        p=self.payload();self.composer.create(p);tid=str(uuid.uuid4())
        self.composer.update_creation(p['requestId'],'created',tid)
        await self.composer.sync()
        self.assertNotIn('create',self.desktop.calls)
        self.assertEqual(self.queue.rows(tid)[0]['id'],p['messageId'])

    async def test_settings_offline_and_version_conflict_do_not_submit(self):
        tid=str(uuid.uuid4());self.queue.register(tid,'test')
        p=dict(threadId=tid,requestId=str(uuid.uuid4()),version='stale',model='b',effort='high')
        self.assertEqual((await self.composer.apply_settings(p))['status'],'conflict')
        self.desktop.online=False
        with self.assertRaises(ValueError):await self.composer.apply_settings({**p,'version':'one'})
        self.assertNotIn('settings',self.desktop.calls)

    async def test_settings_lost_confirmation_blocks_new_changes_and_reconciles_without_reapply(self):
        tid=str(uuid.uuid4());self.queue.register(tid,'test');self.desktop.fail='after'
        p=dict(threadId=tid,requestId=str(uuid.uuid4()),version='one',model='b',effort='high')
        self.assertEqual((await self.composer.apply_settings(p))['status'],'uncertain')
        with self.assertRaises(ValueError):await self.composer.apply_settings({**p,'requestId':str(uuid.uuid4())})
        await self.queue.close();self.open()
        await self.composer.sync()
        self.assertEqual(self.composer.settings_pending(tid)['status'],'applied')
        self.assertEqual(self.desktop.calls.count('settings'),1)

    async def test_rejects_remote_paths_partial_setting_pair_and_oversize_input(self):
        for change in ({'target':{'type':'remote'}},{'target':{'type':'projectless','cwd':'C:/'}},{'model':'a'},{'text':'x'*32001}):
            with self.assertRaises(ValueError):self.composer.create({**self.payload(),**change})


class PlanWorkflowTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = ComposerTests.asyncSetUp
    asyncTearDown = ComposerTests.asyncTearDown
    payload = ComposerTests.payload

    def open(self):
        ComposerTests.open(self)
        self.queue.workflow=self.composer

    async def test_native_plan_mode_setting_is_gated_by_owner_capability(self):
        tid=str(uuid.uuid4());self.queue.register(tid,'Plan')
        p=dict(requestId=str(uuid.uuid4()),threadId=tid,version='one',model='a',effort='low',mode='plan')
        self.assertEqual((await self.composer.apply_settings(p))['status'],'unsupported')
        self.assertNotIn('settings',self.desktop.calls)

    async def test_plan_adoption_ack_loss_survives_restart_without_repeating(self):
        tid=str(uuid.uuid4());self.queue.register(tid,'Plan')
        plan={'id':'implement:turn','turnId':'turn','text':'Reply DONE'}
        original=self.desktop.call
        calls=0
        async def desktop(operation,thread,**params):
            nonlocal calls
            if operation=='snapshot':
                return {'protocol':'mobile-queue-v2','threadId':thread,'receipts':[], 'settings':self.desktop.settings,'planMode':True,'planReview':plan}
            if operation=='implement-plan':
                calls+=1
                raise OSError('ack lost after append')
            if operation=='implementation-status':return {'status':'applied'}
            return await original(operation,thread,**params)
        self.desktop.call=desktop
        p=dict(requestId=str(uuid.uuid4()),messageId=str(uuid.uuid4()),threadId=tid,version='one',planId=plan['id'],turnId=plan['turnId'])
        self.assertEqual((await self.composer.implement_plan(p))['status'],'uncertain')
        with self.assertRaises(ValueError):await self.queue.enqueue(tid,str(uuid.uuid4()),'Follow-up')
        await self.queue.close();self.open()
        await self.composer.sync()
        self.assertEqual((await self.composer.implement_plan(p))['status'],'applied')
        self.assertEqual(calls,1)

    async def test_plan_adoption_cannot_overtake_untransferred_phone_message(self):
        tid=str(uuid.uuid4());self.queue.register(tid,'Plan')
        await self.queue.enqueue(tid,str(uuid.uuid4()),'Continue planning')
        p=dict(requestId=str(uuid.uuid4()),messageId=str(uuid.uuid4()),threadId=tid,version='one',planId='plan',turnId='turn')
        self.assertEqual((await self.composer.implement_plan(p))['status'],'busy')
        self.assertNotIn('implement-plan',self.desktop.calls)

    async def test_offline_new_plan_request_stays_cancellable_without_running_in_default_mode(self):
        p={**self.payload(),'mode':'plan'};self.composer.create(p)
        await self.composer.sync()
        self.assertEqual(self.composer.creation(p['requestId'])['status'],'waiting')
        self.assertNotIn('create',self.desktop.calls)
        self.composer.cancel(p['requestId'])
