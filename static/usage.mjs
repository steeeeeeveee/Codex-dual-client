const reasons = {'needs-upgrade':'需要更新兼容桌面', 'desktop-offline':'电脑未连接，恢复后自动刷新', 'login-required':'请在电脑登录 Codex 账号', 'account-changed':'账号已变化，等待重新读取', 'read-failed':'暂时无法读取额度', 'windows-unavailable':'当前账号未返回这两个额度窗口', 'unverified':'当前账号尚未核对'};
export function resetLabel(seconds, now = new Date()) {
  if (!seconds) return '重置时间暂不可用';
  const date = new Date(seconds * 1000);
  if (!Number.isFinite(date.getTime())) return '重置时间暂不可用';
  if (date <= now) return '重置时间已到，等待更新';
  const sameDay = date.toDateString() === now.toDateString();
  return (sameDay ? '今天 ' : new Intl.DateTimeFormat('zh-CN', {month:'numeric',day:'numeric'}).format(date)+' ') + new Intl.DateTimeFormat('zh-CN', {hour:'2-digit',minute:'2-digit',hour12:false}).format(date) + ' 重置';
}
export function renderUsage(card, data, now = new Date()) {
  card.hidden = false;
  for (const name of ['fiveHour','weekly']) {
    const tile = card.querySelector(`[data-window="${name}"]`), value = data.windows?.[name];
    const percent = value?.remainingPercent, valid = typeof percent === 'number' && Number.isFinite(percent);
    const remaining = valid ? Math.max(0, Math.min(100, percent)) : null;
    tile.className = 'usageTile ' + (remaining === null ? 'unknown' : remaining >= 70 ? 'green' : remaining >= 30 ? 'amber' : 'red');
    tile.querySelector('.usagePercent').textContent = remaining === null ? '—' : Math.round(remaining)+'%';
    tile.querySelector('.usageDetail').textContent = remaining === null ? '暂不可用' : remaining === 0 ? '已用尽' : '剩余额度';
    const progress = tile.querySelector('progress');
    progress.hidden = remaining === null; progress.value = remaining ?? 0;
    tile.querySelector('.usageReset').textContent = remaining === null ? '等待额度数据' : resetLabel(value.resetsAt, now);
  }
  const updated = data.fetchedAt ? new Intl.DateTimeFormat('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(data.fetchedAt*1000)) : null;
  card.querySelector('.usageStatus').textContent = (data.status === 'stale' ? '历史数据 · ' : '') + (updated ? '最近更新：'+updated : '额度暂不可用') + (data.reason ? ' · '+(reasons[data.reason] || '等待重新读取') : '');
  card.classList.toggle('usageStale', data.status === 'stale');
}

export class UsageController {
  constructor(card, api, doc = document) {
    this.card = card; this.api = api; this.doc = doc; this.authenticated = false; this.generation = 0; this.timer = null; this.inflight = null; this.lastManual = -Infinity;
    this.button = card.querySelector('button');
    this.button.onclick = () => {if(Date.now()-this.lastManual<5000)return;this.lastManual=Date.now();this.refresh(true);};
    doc.addEventListener('visibilitychange', () => {clearTimeout(this.timer);if(this.authenticated&&!doc.hidden)this.refresh(true);});
  }
  setAuthenticated(value) {
    if (value === this.authenticated) return;
    this.authenticated = value; this.generation++;
    clearTimeout(this.timer);
    if (value) {renderUsage(this.card,{status:'unavailable',windows:{}});this.card.querySelector('.usageStatus').textContent='正在读取额度…';this.refresh(true);}
    else {this.data=null;this.card.hidden=true;this.button.disabled=false;this.button.textContent='刷新';}
  }
  async refresh(force = false) {
    if (!this.authenticated || this.doc.hidden) return;
    if (this.inflight?.generation === this.generation) return this.inflight.promise;
    const generation = this.generation;
    this.button.disabled = true;this.button.textContent='读取中…';
    const promise = (async () => {
      try {
        const data = await this.api('usage'+(force?'?refresh=true':''));
        if(generation!==this.generation)return;
        this.data=data;renderUsage(this.card,data);
      } catch(error) {
        if(generation!==this.generation)return;
        if(error.status===401){this.setAuthenticated(false);return;}
        renderUsage(this.card,{...this.data,status:this.data?.fetchedAt?'stale':'unavailable',reason:'desktop-offline'});
      } finally {
        if(generation===this.generation){
          this.inflight=null;this.button.disabled=false;this.button.textContent='刷新';clearTimeout(this.timer);
          if(this.authenticated&&!this.doc.hidden){
            const future = Object.values(this.data?.windows||{}).map(w=>w?.resetsAt*1000-Date.now()).filter(ms=>ms>0);
            this.timer=setTimeout(()=>this.refresh(),Math.min(60000,...future));
          }
        }
      }
    })();
    this.inflight={generation,promise};return promise;
  }
}
