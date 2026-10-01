import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock
from mobile_usage import UsageService

KEY='a'*64
def fresh(key=KEY, percent=82):
    return dict(status='fresh',accountKey=key,windows=dict(fiveHour=dict(remainingPercent=percent,resetsAt=2000000000),weekly=None))

class UsageTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp=tempfile.TemporaryDirectory();self.path=Path(self.temp.name)/'cache.sqlite';self.now=1000
        self.value=fresh();self.adapter=AsyncMock()
        async def call(operation, tid):
            await asyncio.sleep(.001)
            return {'usage':True} if operation=='capabilities' else self.value
        self.adapter.call.side_effect=call
        self.service=UsageService(self.adapter,self.path,clock=lambda:self.now)

    async def asyncTearDown(self):
        await self.service.close();self.temp.cleanup()

    async def test_coalesced_cache_manual_cooldown_and_sanitized_storage(self):
        result=await asyncio.gather(*[self.service.get(True) for _ in range(15)])
        self.assertTrue(all(v['status']=='fresh' for v in result));self.assertEqual(self.adapter.call.await_count,2)
        self.assertNotIn('accountKey',json.dumps(result[0]));self.assertEqual(result[0]['windows']['weekly'],None)
        await self.service.get(True);self.assertEqual(self.adapter.call.await_count,2)
        self.now+=5;await self.service.get(True);self.assertEqual(self.adapter.call.await_count,4)
        raw=self.service.db.execute('SELECT value FROM mobile_usage_cache').fetchone()[0]
        self.assertEqual(set(json.loads(raw)),{'accountKey','fetchedAt','windows'})

    async def test_account_change_logout_partial_and_transport_failure(self):
        await self.service.get();self.now+=60
        self.value=dict(status='unavailable',reason='read-failed',accountKey=KEY)
        self.assertEqual((await self.service.get())['status'],'stale')
        self.now+=60;self.value=dict(status='unavailable',reason='read-failed',accountKey='b'*64)
        result=await self.service.get();self.assertIsNone(result['fetchedAt']);self.assertIsNone(self.service.cache)
        self.now+=60;self.value=fresh('b'*64,0);result=await self.service.get();self.assertEqual(result['windows']['fiveHour']['remainingPercent'],0)
        self.now+=60;self.value=dict(status='unavailable',reason='login-required',accountKey=None)
        self.assertEqual((await self.service.get())['reason'],'login-required');self.assertIsNone(self.service.cache)

    async def test_restart_and_offline_are_historical_until_account_verified(self):
        await self.service.get();await self.service.close()
        self.adapter=AsyncMock();self.adapter.call.side_effect=RuntimeError('offline')
        self.service=UsageService(self.adapter,self.path,clock=lambda:self.now)
        self.assertEqual(self.service.result['status'],'stale')
        self.assertEqual((await self.service.get())['reason'],'desktop-offline')
        self.assertEqual(self.service.result['windows']['fiveHour']['remainingPercent'],82)

    async def test_unsupported_never_calls_usage_and_reset_requeries_without_inventing(self):
        self.adapter.call.side_effect=None;self.adapter.call.return_value={'usage':False}
        self.assertEqual((await self.service.get())['reason'],'needs-upgrade')
        self.assertEqual(self.adapter.call.await_count,1)
        self.now+=60;self.adapter.call.side_effect=lambda op,tid:{'usage':True} if op=='capabilities' else fresh()
        self.value=fresh();self.value['windows']['fiveHour']['resetsAt']=self.now+10
        self.adapter.call.side_effect=lambda op,tid:{'usage':True} if op=='capabilities' else self.value
        await self.service.get();self.now+=10;self.value=fresh(percent=49)
        result=await self.service.get();self.assertEqual(result['windows']['fiveHour']['remainingPercent'],49)
