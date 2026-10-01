import {effortLabel} from './settings.mjs';
import {KeyboardViewport} from './keyboard_viewport.mjs';
import {FloatingNotices} from './notices.mjs';
import {ScrollBottom} from './scroll_bottom.mjs';

export function setText(element,value) {
  if(element.textContent!==value)element.textContent=value;
}

// Presentation only: business events still belong to app.js.
export class MobileShell {
  constructor(doc = document) {
    this.doc = doc; this.win = doc.defaultView; this.$ = id => doc.getElementById(id);
    this.drawerOpen = false; this.panelView = null; this.listKey = ''; this.drawerTimer = null;
    this.drawerClosing=false;this.drawerAfterClose=null;this.drawerRestore=false;
    this.promptNaturalHeight=null;this.promptLayoutKey='';this.promptMeasure=null;
    this.notices=new FloatingNotices(doc);this.drawerGesture=null;this.drawerFrame=null;this.swipeClickUntil=0;
    this.$('openDrawer').onclick = () => this.openDrawer();
    this.$('closeDrawer').onclick = this.$('drawerScrim').onclick = () => this.closeDrawer();
    this.$('openMode').onclick = () => this.openPanel('mode');
    this.$('openModel').onclick = () => this.openPanel('models');
    this.$('closeSettings').onclick = this.$('settingsScrim').onclick = () => this.closePanel();
    for (const button of doc.querySelectorAll('[data-mode]')) button.onclick = () => {
      const select = this.$('conversationMode'); if (select.disabled) return;
      select.value = button.dataset.mode;select.dispatchEvent(new this.win.Event('change', {bubbles:true}));
    };
    doc.addEventListener('keydown', event => this.keyboard(event));
    const workspace=this.$('workspace');
    workspace.addEventListener('touchstart',event=>this.swipeTouch(event,'start'),{passive:true});
    workspace.addEventListener('touchmove',event=>this.swipeTouch(event,'move'),{passive:false});
    workspace.addEventListener('touchend',event=>this.swipeTouch(event,'end'),{passive:true});
    workspace.addEventListener('touchcancel',()=>this.cancelDrawerGesture());
    workspace.addEventListener('click',event=>{if(this.win.performance.now()<this.swipeClickUntil){event.preventDefault();event.stopImmediatePropagation();}},true);
    this.$('prompt').addEventListener('input', () => this.fitPrompt());
    this.$('composerDock').addEventListener('click', event => {
      if(this.panelView && !this.$('settingsPanel').contains(event.target) && !event.target.closest('#openMode,#openModel'))this.closePanel();
    });
    this.viewportController=new KeyboardViewport(doc,()=>this.fitPrompt(false),()=>this.scrollBottom?.schedule());
    this.scrollBottom=new ScrollBottom(doc,this.viewportController);
    this.$('chatShell').addEventListener('transitionend',event=>{
      if(event.target===this.$('chatShell')&&event.propertyName==='transform'&&this.drawerClosing)this.finishDrawer();
    });
    this.viewport();
  }
  viewport() {this.viewportController.viewport();}
  notify(text='',source=null) {this.notices.show(text,'notice',source);}
  swipeTouch(event,phase) {
    if(phase==='end'?event.touches.length>0:event.touches.length!==1){this.cancelDrawerGesture();return;}
    const touches=phase==='end'?event.changedTouches:event.touches;
    const touch=[...touches].find(touch=>!this.drawerGesture||touch.identifier===this.drawerGesture.id);if(!touch)return;
    const input={pointerType:'touch',pointerId:touch.identifier,clientX:touch.clientX,clientY:touch.clientY,target:event.target,cancelable:event.cancelable,preventDefault:()=>event.preventDefault()};
    if(phase==='start')this.swipeStart(input);else if(phase==='move')this.swipeMove(input);else this.swipeEnd(input);
  }
  swipeStart(event) {
    this.cancelDrawerGesture();
    if(event.pointerType!=='touch'||event.isPrimary===false)return;
    // Suppress the release-generated click, not the user's next real tap.
    this.swipeClickUntil=0;
    const selection=this.win.getSelection?.();
    if(this.panelView||this.$('workspace').hidden||selection&&!selection.isCollapsed)return;
    // Leave native controls, image gestures, horizontal content and Safari's
    // left/right navigation edges alone in Safari. The standalone phone app
    // has no browser navigation gesture to reserve. Rows still accept swipes.
    const standalone=this.win.navigator.standalone||this.win.matchMedia?.('(display-mode: standalone)').matches;
    const edge=standalone?0:24;
    if(event.clientX<edge||event.clientX>this.win.innerWidth-edge||event.target.closest('input,textarea,select,a,summary,pre,table,.table-scroll,.chatImage,.imageViewer,.math-display,.math-inline,#composerDock,.floatingNotice,[contenteditable=true]'))return;
    if(event.target.closest('button:not(.threadItem):not(.drawerScrim)'))return;
    const width=this.$('drawer').getBoundingClientRect().width||Math.min(this.win.innerWidth*.82,340);
    // Read the rendered position once, so a new drag can catch an unfinished
    // slide without snapping to its target. No layout reads happen on moves.
    const transform=this.win.getComputedStyle(this.$('chatShell')).transform;
    const matrix=transform.match(/^matrix(3d)?\(([^)]+)\)$/);
    const rendered=matrix?Number(matrix[2].split(',')[matrix[1]?12:4]):NaN;
    const base=Number.isFinite(rendered)?Math.max(0,Math.min(width,rendered)):this.drawerOpen?width:0;
    this.drawerGesture={id:event.pointerId,x:event.clientX,y:event.clientY,locked:false,open:this.drawerOpen,width,base,position:base,samples:[{position:base,time:this.win.performance.now()}]};
  }
  swipeMove(event) {
    const gesture=this.drawerGesture;if(!gesture||gesture.id!==event.pointerId)return;
    const dx=event.clientX-gesture.x,dy=event.clientY-gesture.y;
    if(!gesture.locked){
      if(Math.abs(dy)>8&&Math.abs(dy)>Math.abs(dx)*.8){this.drawerGesture=null;return;}
      if(Math.abs(dx)<8||Math.abs(dx)<Math.abs(dy)*1.25)return;
      if(gesture.base<=0&&dx<0||gesture.base>=gesture.width&&dx>0){this.drawerGesture=null;return;}
      gesture.locked=true;
      this.win.clearTimeout(this.drawerTimer);this.drawerClosing=false;this.drawerAfterClose=null;
      this.$('workspace').style.removeProperty('--drawer-settle-duration');
      this.$('workspace').classList.add('drawerVisible','drawerDragging');
      this.$('drawer').hidden=false;this.$('drawerScrim').hidden=false;
      this.paintDrawerGesture();this.scrollBottom.schedule();
    }
    if(event.cancelable)event.preventDefault();
    this.sampleDrawerGesture(event.clientX);
    if(this.drawerFrame===null)this.drawerFrame=this.win.requestAnimationFrame(()=>{
      this.drawerFrame=null;this.paintDrawerGesture();
    });
  }
  swipeEnd(event) {
    const gesture=this.drawerGesture;if(!gesture||gesture.id!==event.pointerId)return;
    if(!gesture.locked){this.drawerGesture=null;return;}
    this.sampleDrawerGesture(event.clientX);
    const now=this.win.performance.now(),cutoff=now-100;
    let first=gesture.samples[0];
    for(const sample of gesture.samples.slice(1)){
      if(sample.time<=cutoff){first=sample;continue;}
      // Sparse touch events can straddle the velocity window. Interpolate its
      // boundary instead of treating a quick drag as stationary at release.
      if(first.time<cutoff){
        const ratio=(cutoff-first.time)/Math.max(1,sample.time-first.time);
        first={time:cutoff,position:first.position+(sample.position-first.position)*ratio};
      }
      break;
    }
    const velocity=(gesture.position-first.position)/Math.max(1,now-first.time);
    const travel=gesture.position-gesture.base;
    // A short deliberate flick commits in its release direction. A slow drag
    // must move a third of the drawer's width from its initial state.
    const flick=Math.abs(travel)>=12&&Math.abs(velocity)>=.28;
    const threshold=gesture.width/3;
    const distanceOpen=gesture.open?gesture.width-gesture.position<threshold:gesture.position>=threshold;
    this.settleDrawerGesture(flick?velocity>0:distanceOpen);
  }
  sampleDrawerGesture(x) {
    const gesture=this.drawerGesture,now=this.win.performance.now();
    gesture.position=Math.max(0,Math.min(gesture.width,gesture.base+x-gesture.x));
    gesture.samples.push({position:gesture.position,time:now});
    while(gesture.samples.length>2&&now-gesture.samples[1].time>100)gesture.samples.shift();
  }
  paintDrawerGesture() {
    const gesture=this.drawerGesture;if(!gesture?.locked)return;
    const progress=gesture.position/gesture.width,style=this.$('workspace').style;
    style.setProperty('--drawer-drag-x',gesture.position+'px');
    style.setProperty('--drawer-drag-opacity',String(progress));
    style.setProperty('--drawer-drag-progress',String(progress));
  }
  clearDrawerGesture() {
    if(this.drawerFrame!==null)this.win.cancelAnimationFrame(this.drawerFrame);
    this.drawerFrame=null;this.drawerGesture=null;
    this.$('workspace').classList.remove('drawerDragging');
    for(const name of ['--drawer-drag-x','--drawer-drag-opacity','--drawer-drag-progress'])this.$('workspace').style.removeProperty(name);
  }
  settleDrawerGesture(open) {
    const gesture=this.drawerGesture;if(!gesture?.locked){this.clearDrawerGesture();return;}
    this.paintDrawerGesture();
    // Commit the finger's last rendered position before enabling the settling
    // transition. This is the only forced layout, once at release.
    void this.$('chatShell').offsetWidth;
    const remaining=Math.abs((open?gesture.width:0)-gesture.position);
    const duration=remaining<.5?0:Math.round(360+160*remaining/gesture.width);
    this.swipeClickUntil=this.win.performance.now()+400;
    open?this.openDrawer(duration):this.closeDrawer(false,null,duration);
  }
  cancelDrawerGesture() {
    if(this.drawerGesture?.locked)this.settleDrawerGesture(this.drawerGesture.open);
    else this.clearDrawerGesture();
  }
  followsChat(tolerance=80) {return this.viewportController.followsChat(tolerance);}
  fitPrompt(preserveScroll=true) {
    const input=this.$('prompt');if(input.closest('[hidden]'))return;
    // Idle polling and viewport changes can reuse natural text height. Only
    // changed text or layout width needs a DOM measurement and computed style.
    const key=JSON.stringify([input.value,this.win.innerWidth]);
    if(key!==this.promptLayoutKey||this.promptNaturalHeight===null){
      const width=input.clientWidth;if(!width&&this.promptMeasure)return;
      const style=this.win.getComputedStyle(input);
      const properties=['font','lineHeight','letterSpacing','paddingTop','paddingBottom','paddingLeft','paddingRight','boxSizing','whiteSpace','wordBreak','overflowWrap','tabSize'];
      // Measure outside the chat flex layout. Collapsing the real textarea even
      // briefly clamps chat scroll positions and pans Safari's focused viewport.
      if(!this.promptMeasure){
        const measure=this.promptMeasure=input.cloneNode(false);measure.removeAttribute('id');measure.removeAttribute('name');
        measure.className='promptMeasure';measure.tabIndex=-1;measure.setAttribute('aria-hidden','true');measure.readOnly=true;measure.rows=1;
        Object.assign(measure.style,{position:'fixed',left:'-10000px',top:'0',visibility:'hidden',pointerEvents:'none',height:'0',minHeight:'0',maxHeight:'none',border:'0',overflow:'hidden'});
        this.doc.body.append(measure);
      }
      for(const name of properties)this.promptMeasure.style[name]=style[name];
      this.promptMeasure.style.width=width+'px';this.promptMeasure.value=input.value;
      this.promptNaturalHeight=Math.max(this.promptMeasure.scrollHeight,44);this.promptLayoutKey=key;
    }
    const height=Math.ceil(Math.min(this.promptNaturalHeight,this.viewportController?.promptLimit||180))+'px';
    if(input.style.height===height)return;
    const scroll=this.$('chatScroll'),save=preserveScroll&&!this.viewportController?.motion;
    const position=save?scroll.scrollTop:0,follow=save&&this.followsChat();
    input.style.height=height;this.viewportController?.geometry();
    if(save)scroll.scrollTop=follow?scroll.scrollHeight:position;
  }
  openDrawer(duration=null) {
    this.closePanel(false);this.win.clearTimeout(this.drawerTimer);
    const fromDrag=this.$('workspace').classList.contains('drawerDragging');
    this.clearDrawerGesture();
    duration===null?this.$('workspace').style.removeProperty('--drawer-settle-duration'):this.$('workspace').style.setProperty('--drawer-settle-duration',duration+'ms');
    this.drawerClosing=false;this.drawerAfterClose=null;
    this.$('drawer').hidden=false;this.$('drawer').inert=false;this.drawerOpen=true;
    this.$('chatShell').inert=true;this.$('drawerScrim').hidden=false;
    this.$('workspace').classList.add('drawerVisible');
    this.$('openDrawer').setAttribute('aria-expanded','true');
    // Layout before transition, rather than a timer that can outlive a close.
    if(!fromDrag)void this.$('drawer').offsetWidth;
    this.$('workspace').classList.add('drawerOpen');
    this.$('closeDrawer').focus({preventScroll:true});
    this.scrollBottom.schedule();
  }
  closeDrawer(restore = true,afterClose = null,duration=null) {
    if(!this.drawerOpen&&!this.$('workspace').classList.contains('drawerDragging')){this.clearDrawerGesture();if(!this.drawerClosing)afterClose?.();return;}
    this.clearDrawerGesture();
    duration===null?this.$('workspace').style.removeProperty('--drawer-settle-duration'):this.$('workspace').style.setProperty('--drawer-settle-duration',duration+'ms');
    this.$('chatShell').inert=true;
    this.drawerOpen=false;this.$('workspace').classList.remove('drawerOpen');
    this.drawerClosing=true;this.drawerAfterClose=afterClose;this.drawerRestore=restore;
    this.$('openDrawer').setAttribute('aria-expanded','false');
    this.$('drawer').inert=true;
    if(duration===0||this.win.matchMedia?.('(prefers-reduced-motion: reduce)').matches){this.finishDrawer();return;}
    this.drawerTimer=this.win.setTimeout(()=>this.finishDrawer(),(duration??500)+60);
  }
  finishDrawer() {
    if(!this.drawerClosing)return;
    this.win.clearTimeout(this.drawerTimer);this.drawerClosing=false;
    this.$('workspace').style.removeProperty('--drawer-settle-duration');
    this.$('workspace').classList.remove('drawerVisible');
    this.$('drawer').hidden=true;this.$('drawer').inert=false;
    this.$('drawerScrim').hidden=true;this.$('chatShell').inert=false;
    const after=this.drawerAfterClose;this.drawerAfterClose=null;
    if(this.drawerRestore)this.$('openDrawer').focus({preventScroll:true});
    after?.();
    this.scrollBottom.schedule();
  }
  openPanel(view) {
    if(this.panelView===view){this.closePanel();return;}
    this.closeDrawer(false);
    this.panelView=view;this.$('settingsPanel').dataset.view=view;
    this.$('panelTitle').textContent=view==='mode'?'对话模式':'模型与思考强度';
    this.$('settingsPanel').hidden=false;this.$('settingsScrim').hidden=false;
    this.$('workspace').classList.add('panelOpen');
    this.$('openMode').setAttribute('aria-expanded',String(view==='mode'));
    this.$('openModel').setAttribute('aria-expanded',String(view==='models'));
    for(const id of ['compose','chatScroll','queueCard'])this.$(id).inert=true;
    this.doc.querySelector('.chatHeader').inert=true;
    this.$('closeSettings').focus({preventScroll:true});
    this.scrollBottom.schedule();
  }
  closePanel(restore = true) {
    if(!this.panelView)return;
    const origin=this.panelView==='mode'?'openMode':'openModel';this.panelView=null;
    this.$('settingsPanel').hidden=true;this.$('settingsScrim').hidden=true;
    this.$('workspace').classList.remove('panelOpen');
    this.$('openMode').setAttribute('aria-expanded','false');this.$('openModel').setAttribute('aria-expanded','false');
    for(const id of ['compose','chatScroll','queueCard'])this.$(id).inert=false;
    this.doc.querySelector('.chatHeader').inert=false;
    if(restore&&!this.$(origin).disabled)this.$(origin).focus({preventScroll:true});
    this.scrollBottom.schedule();
  }
  closeAll() {
    // A deliberate conversation/draft change must not inherit a pending
    // keyboard restore captured from the previous conversation.
    this.viewportController.cancel();
    this.closeDrawer(false);this.closePanel(false);
    if(this.$('workspace').hidden){this.drawerAfterClose=null;this.finishDrawer();}
  }
  keyboard(event) {
    if(!this.panelView&&!this.drawerOpen)return;
    if(event.key==='Escape'){event.preventDefault();this.drawerOpen?this.closeDrawer():this.closePanel();return;}
    if(event.key!=='Tab')return;
    const root=this.$(this.drawerOpen?'drawer':'settingsPanel');
    const elements=[...root.querySelectorAll('button,input,select,textarea,summary,[tabindex="0"]')].filter(el=>!el.disabled&&!el.closest('[hidden],.srOnly')&&this.win.getComputedStyle(el).display!=='none'&&(!el.closest('details')||el.closest('details').open||el.tagName==='SUMMARY')&&(!this.panelView||!el.closest('.settingFields,#nativeModeControl,#newLocation')||this.win.getComputedStyle(el.closest('.settingFields,#nativeModeControl,#newLocation')).display!=='none'));
    if(!elements.length){event.preventDefault();root.focus({preventScroll:true});return;}
    const index=elements.indexOf(this.doc.activeElement);
    if(event.shiftKey&&index<=0){event.preventDefault();elements.at(-1).focus({preventScroll:true});}
    else if(!event.shiftKey&&(index===elements.length-1||index===-1)){event.preventDefault();elements[0].focus({preventScroll:true});}
  }
  renderThreads(selected, busy) {
    const options=[...this.$('threads').options].filter(option=>option.value);
    const key=JSON.stringify(options.map(option=>[option.value,option.textContent]));
    if(key!==this.listKey){
      this.listKey=key;this.$('threadList').replaceChildren();
      for(const option of options){
        const button=this.doc.createElement('button');button.type='button';button.className='threadItem';
        button.dataset.threadId=option.value;button.textContent=option.textContent;button.title=option.textContent;
        button.onclick=()=>{
          if(this.$('threads').value===option.value){this.closeDrawer();return;}
          this.closeDrawer(false,()=>{
            this.$('threads').value=option.value;this.closePanel(false);
            this.$('threads').dispatchEvent(new this.win.Event('change',{bubbles:true}));
          });
        };
        this.$('threadList').append(button);
      }
      if(!options.length){const empty=this.doc.createElement('p');empty.className='threadEmpty';empty.textContent='暂无对话';this.$('threadList').append(empty);}
    }
    for(const item of this.$('threadList').querySelectorAll('button')){item.disabled=busy;item.setAttribute('aria-current',String(item.dataset.threadId===selected));}
  }
  sync({newMode,selected,current,busy,settingsBase,settingsDirty,capabilities,serviceOnline,streamOnline,creationRequest,creationRows}) {
    if(this.$('workspace').hidden){this.closeAll();this.notices.clear();}
    this.$('workspace').classList.toggle('draftView',newMode||!selected);
    this.$('welcome').hidden=!(newMode||!selected);this.$('transcript').hidden=newMode||!selected;
    const title=current.thread?.name||[...this.$('threads').options].find(o=>o.value===selected)?.textContent||'已有对话';
    setText(this.$('chatTitle'),newMode||!selected?'':title);
    this.renderThreads(selected,busy);this.fitPrompt();
    const shared=current.mode==='shared'&&current.threadId===selected;
    const next=newMode?{model:this.$('model').value,effort:this.$('effort').value,mode:this.$('conversationMode').value}:settingsBase?.next;
    const model=capabilities.models.find(model=>model.id===next?.model);
    const caption=(model?.name||next?.model||'桌面默认')+(next?.effort?' '+effortLabel(next.effort):'');
    setText(this.$('modelLabel'),caption);this.$('openModel').title=caption;
    this.$('openModel').disabled=this.$('modelControls').hidden||busy;this.$('openMode').disabled=busy;
    this.$('dirtyDot').hidden=newMode||!settingsDirty;
    this.$('planBadge').hidden=next?.mode!=='plan';
    this.$('nativeModeHint').hidden=newMode?!!capabilities.planMode:!!current.planMode;
    this.$('settingsStatus').hidden=newMode;
    this.$('settingsHint').hidden=serviceOnline&&!settingsDirty&&current.settingsOperation?.status!=='uncertain'&&(newMode?!capabilities.stale:shared&&current.desktop?.connected);
    for(const button of this.doc.querySelectorAll('[data-mode]')){button.disabled=this.$('conversationMode').disabled;button.setAttribute('aria-pressed',String(button.dataset.mode===this.$('conversationMode').value));}
    for(const id of ['send','stop']){this.$(id).setAttribute('aria-label',this.$(id).textContent);this.$(id).title=this.$(id).textContent;}
    if(!current.turnId)this.$('stop').hidden=true;
    const queued=new Set((current.queue||[]).map(item=>item.id));
    const outbox=(current.outbox||[]).filter(item=>!queued.has(item.id)&&['waiting','checking','needs-review','queued'].includes(item.status));
    const count=queued.size+outbox.length;
    this.$('queueCard').hidden=newMode||!shared||!count;setText(this.$('queueCount'),count+' 条');
    const labels={waiting:current.desktop?.connected?'等待转交':'等待电脑',checking:'正在核对投递结果','needs-review':'结果待核对 · 后续转交已暂停',queued:'电脑已接收 · 正在同步队列'};
    const queueWarning=[...new Set(outbox.map(item=>labels[item.status]))];
    for(const item of current.queue||[])if(item.pausedReason)queueWarning.push('队列已暂停：'+item.pausedReason);
    setText(this.$('queueAlert'),queueWarning.join(' · '));this.$('queueAlert').hidden=!queueWarning.length;
    let alert=!serviceOnline?'连接中断 · 自动重连':!newMode&&shared&&!current.desktop?.connected?(current.desktop?.reason||'等待电脑连接'):!newMode&&shared&&!streamOnline?'回复连接中断 · 正在重连':'';
    if(newMode&&creationRequest){const row=creationRows.find(row=>row.requestId===creationRequest.requestId);alert=({'waiting':'等待电脑创建','checking':'正在核对创建结果','created':'已创建 · 首条消息等待确认','needs-review':'创建结果待核对','invalid':'创建选项已失效，请在侧栏重新选择'})[row?.status]||'创建请求编号已保留，正在核对结果';}
    setText(this.$('connectionAlert'),alert);this.$('connectionAlert').hidden=!alert;
    if(!this.$('workspace').hidden)this.notices.show(alert,'connectionAlert','connection');
    this.viewportController.geometry();
    this.scrollBottom.schedule();
  }
}
