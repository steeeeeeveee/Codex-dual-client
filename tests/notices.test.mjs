import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {FloatingNotices} from '../static/notices.mjs';

function fixture(t){
  const dom=new JSDOM('<div id="toastStack"></div>');t.after(()=>dom.window.close());
  const pending=[];dom.window.setTimeout=(fn,delay)=>{pending.push({fn,delay});return pending.length;};
  dom.window.requestAnimationFrame=fn=>fn();
  return {notice:new FloatingNotices(dom.window.document),root:dom.window.document.getElementById('toastStack'),pending};
}
test('notices retain insertion order and wording; each holds before fading and removing',t=>{
  const {notice,root,pending}=fixture(t);
  notice.show('桌面已确认');notice.show('桌面未连接','connectionAlert','connection');
  assert.deepEqual([...root.querySelectorAll('.floatingNotice')].map(el=>el.textContent),['桌面已确认','桌面未连接']);
  assert.equal(root.children[0].classList.contains('toastVisible'),true);assert(pending[0].delay>=4500);
  pending.shift().fn();assert.equal(root.children.length,2);assert.equal(root.children[0].classList.contains('toastLeaving'),true);
  pending.find(timer=>timer.delay===340).fn();assert.equal(root.children.length,1);
});
test('status polling does not respawn or extend the same toast; a recovered connection can later warn again',t=>{
  const {notice,root,pending}=fixture(t);notice.show('等待电脑连接','connectionAlert','connection');
  for(let i=0;i<10;i++)notice.show('等待电脑连接','connectionAlert','connection');
  assert.equal(root.children.length,1);assert.equal(pending.length,1);
  pending.shift().fn();pending.shift().fn();assert.equal(root.children.length,0);
  notice.show('等待电脑连接','connectionAlert','connection');assert.equal(root.children.length,0);
  notice.show('','connectionAlert','connection');notice.show('等待电脑连接','connectionAlert','connection');assert.equal(root.children.length,1);
});
test('starting another action does not abruptly remove a visible notice; logging out clears them',t=>{
  const {notice,root}=fixture(t);notice.show('桌面已确认');notice.show('');assert.equal(root.children.length,1);
  notice.clear();assert.equal(root.children.length,0);
});
