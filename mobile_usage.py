"""Account quota cache on a connection independent of the conversation owner."""
import asyncio
import json
import math
import re
import sqlite3
import time


class UsageService:
    def __init__(self, adapter, path, enabled=True, clock=time.time):
        self.adapter, self.enabled, self.clock = adapter, enabled, clock
        self.db = sqlite3.connect(path)
        self.db.execute('CREATE TABLE IF NOT EXISTS mobile_usage_cache (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)')
        row = self.db.execute('SELECT value FROM mobile_usage_cache WHERE id=1').fetchone()
        self.cache = json.loads(row[0]) if row else None
        self.result = self.view('stale', 'unverified')
        self.checked_at = float('-inf')
        self.inflight = None

    def view(self, status, reason=None):
        return dict(status=status if self.cache else 'unavailable', reason=reason,
                    fetchedAt=self.cache['fetchedAt'] if self.cache else None,
                    windows=self.cache['windows'] if self.cache else dict(fiveHour=None, weekly=None))

    def save(self, value):
        self.cache = value
        if value:
            self.db.execute('INSERT OR REPLACE INTO mobile_usage_cache VALUES (1,?)', (json.dumps(value),))
        else:
            self.db.execute('DELETE FROM mobile_usage_cache')
        self.db.commit()

    async def get(self, refresh=False):
        if not self.enabled:
            return dict(status='unavailable', reason='needs-upgrade', fetchedAt=None, windows=dict(fiveHour=None, weekly=None))
        now = self.clock()
        reset_due = self.cache and any(w and w['resetsAt'] and self.checked_at < w['resetsAt'] <= now for w in self.cache['windows'].values())
        interval = 5 if refresh or reset_due else 60
        if self.inflight is None and now - self.checked_at >= interval:
            self.inflight = asyncio.create_task(self.read())
            self.inflight.add_done_callback(lambda task: setattr(self, 'inflight', None))
        if self.inflight:
            return await asyncio.shield(self.inflight)
        return self.result

    async def read(self):
        try:
            capabilities = await self.adapter.call('capabilities', None)
            if not capabilities.get('usage'):
                self.result = self.view('stale', 'needs-upgrade')
                return self.result
            value = await self.adapter.call('usage', None)
            key = value.get('accountKey')
            valid_key = isinstance(key, str) and re.fullmatch('[a-f0-9]{64}', key)
            if value.get('reason') in ('login-required', 'account-changed') or (valid_key and self.cache and key != self.cache['accountKey']):
                self.save(None)
            if value.get('status') == 'fresh' and valid_key:
                windows = {}
                for name in ('fiveHour', 'weekly'):
                    window = value.get('windows', {}).get(name)
                    percent = window.get('remainingPercent') if isinstance(window, dict) else None
                    reset = window.get('resetsAt') if isinstance(window, dict) else None
                    windows[name] = dict(remainingPercent=max(0, min(100, percent)), resetsAt=reset if isinstance(reset, int) and not isinstance(reset, bool) and reset > 0 else None) if isinstance(percent, (int, float)) and not isinstance(percent, bool) and math.isfinite(percent) else None
                if any(windows.values()):
                    self.save(dict(accountKey=key, fetchedAt=self.clock(), windows=windows))
                    self.result = self.view('fresh')
                else:
                    self.result = self.view('stale', 'windows-unavailable')
            else:
                # Never associate old values with an identity we could not verify.
                reason = value.get('reason')
                reason = reason if reason in ('login-required', 'account-changed', 'read-failed', 'windows-unavailable') else 'unverified'
                self.result = self.view('stale', reason if valid_key or not self.cache else 'unverified')
        except Exception:
            self.result = self.view('stale', 'desktop-offline')
        finally:
            self.checked_at = self.clock()
        return self.result

    async def close(self):
        if self.inflight:
            self.inflight.cancel()
            await asyncio.gather(self.inflight, return_exceptions=True)
        await self.adapter.close()
        self.db.close()
