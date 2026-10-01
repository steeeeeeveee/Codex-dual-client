const editable=element=>element?.tagName==='TEXTAREA'||element?.tagName==='INPUT'&&['text','password','search','email','tel','url','number'].includes(element.type);

// Independent composer movement. Business state and sending stay in app.js.
export class KeyboardViewport {
  constructor(doc,onLimit=()=>{},onScrollState=()=>{}) {
    this.doc=doc;this.win=doc.defaultView;this.$=id=>doc.getElementById(id);this.onLimit=onLimit;this.onScrollState=onScrollState;
    this.baseHeight=0;this.width=0;this.visibleHeight=0;this.top=0;this.key='';this.frame=null;
    this.dockHeight=0;this.dockPadding=0;this.chatTop=0;this.chatHeight=0;this.geometryKey='';
    this.lift=0;this.targetLift=0;this.motion=null;this.motionFrame=null;this.settleTimer=null;
    this.focusTimer=null;this.focusFollow=null;this.cycle=false;this.readingLocked=false;this.promptLimit=180;
    this.bottomMotion=null;this.bottomFrame=null;
    const schedule=()=>this.schedule();
    this.win.visualViewport?.addEventListener('resize',schedule);
    this.win.visualViewport?.addEventListener('scroll',schedule);
    this.win.addEventListener('resize',schedule);this.win.addEventListener('scroll',schedule,{passive:true});
    doc.addEventListener('focusin',event=>{
      if(event.target===this.$('prompt')&&!this.cycle)this.focusFollow=this.atBottom(2);
      schedule();this.win.clearTimeout(this.focusTimer);this.focusTimer=this.win.setTimeout(schedule,300);
    });
    doc.addEventListener('focusout',()=>{this.focusFollow=null;schedule();});
    doc.addEventListener('visibilitychange',()=>{if(!doc.hidden)schedule();});
    const manual=()=>{
      this.stopBottomScroll();
      if(this.motion){this.commit();this.motion.manual=true;this.motion.follow=false;this.motion.position=this.$('chatScroll').scrollTop;this.motion.compensation=0;}
      this.readingLocked=true;
    };
    this.$('chatScroll').addEventListener('touchmove',manual,{passive:true});
    this.$('chatScroll').addEventListener('wheel',manual,{passive:true});
    this.$('chatScroll').addEventListener('scroll',()=>{
      if(!this.motion&&this.readingLocked&&this.atBottom(2))this.readingLocked=false;
      this.onScrollState();
    },{passive:true});
    const content=doc.querySelector('.chatContent');
    if(this.win.ResizeObserver){
      this.observer=new this.win.ResizeObserver(entries=>{this.geometry();if(entries.some(entry=>entry.target===content))this.contentChanged();this.onScrollState();});
      for(const element of [this.$('composerDock'),doc.querySelector('.chatHeader'),this.$('notice'),this.$('connectionAlert'),content])this.observer.observe(element);
    } else {
      this.contentObserver=new this.win.MutationObserver(()=>{this.contentChanged();this.onScrollState();});
      this.contentObserver.observe(content,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['hidden']});
    }
  }
  atBottom(tolerance=2) {
    const scroll=this.$('chatScroll');return scroll.scrollHeight-scroll.scrollTop-scroll.clientHeight<=tolerance;
  }
  atVisibleBottom(tolerance=2) {
    // During keyboard motion use its cached geometry, rather than measuring
    // the full transcript on every viewport notification.
    if(!this.motion)return this.atBottom(tolerance);
    if(this.motion.follow&&!this.motion.manual)return true;
    const position=this.motion.manual?this.$('chatScroll').scrollTop:this.motion.position;
    return this.motion.natural-position-Math.max(0,this.chatHeight-this.lift)<=tolerance;
  }
  stopBottomScroll() {
    this.win.cancelAnimationFrame?.(this.bottomFrame);this.bottomFrame=null;this.bottomMotion=null;
  }
  scrollToBottom() {
    if(this.$('workspace').hidden||this.$('workspace').classList.contains('draftView'))return;
    this.stopBottomScroll();
    const scroll=this.$('chatScroll');
    if(this.motion){
      // This is a deliberate scroll, like a manual reading gesture. Keep the
      // composer's animation running without restoring the old reading spot.
      this.commit();this.motion.manual=true;this.motion.follow=false;
      this.motion.position=scroll.scrollTop;this.motion.compensation=0;
    }
    this.focusFollow=null;this.readingLocked=true;
    const duration=this.win.matchMedia?.('(prefers-reduced-motion: reduce)').matches?0:320;
    const motion=this.bottomMotion={from:scroll.scrollTop,start:this.win.performance.now(),duration};
    const frame=time=>{
      if(this.bottomMotion!==motion)return;
      const progress=duration?Math.min(1,(time-motion.start)/duration):1;
      const maximum=Math.max(0,scroll.scrollHeight-scroll.clientHeight);
      scroll.scrollTop=motion.from+(maximum-motion.from)*(1-Math.pow(1-progress,3));
      this.onScrollState();
      // The bottom may move while a reply streams or the keyboard settles.
      // Retarget the same animation; never restore an earlier transcript end.
      if((progress<1||this.motion)&&this.win.requestAnimationFrame){this.bottomFrame=this.win.requestAnimationFrame(frame);return;}
      this.stopBottomScroll();this.readingLocked=false;this.onScrollState();
    };
    if(duration&&this.win.requestAnimationFrame)this.bottomFrame=this.win.requestAnimationFrame(frame);
    else frame(motion.start+duration);
  }
  followsChat(tolerance=80) {
    if(this.bottomMotion)return false;
    if(this.motion)return this.motion.follow&&!this.motion.manual;
    return !this.readingLocked&&this.atBottom(tolerance);
  }
  schedule() {
    if(this.frame!==null)return;
    if(!this.win.requestAnimationFrame){this.viewport();return;}
    this.frame=this.win.requestAnimationFrame(()=>{this.frame=null;this.viewport();});
  }
  viewport() {
    const viewport=this.win.visualViewport,height=Math.round(viewport?.height||this.win.innerHeight),width=this.win.innerWidth;
    const top=Math.max(0,Math.round(Number.isFinite(viewport?.pageTop)?viewport.pageTop:(this.win.scrollY||0)+(viewport?.offsetTop||0)));
    const editing=editable(this.doc.activeElement);
    const previousBase=this.baseHeight,layoutHeight=this.doc.documentElement.clientHeight||this.win.innerHeight;
    if(!this.baseHeight)this.baseHeight=height;
    if(this.width&&width!==this.width){
      this.cancel();this.baseHeight=Math.max(height,this.doc.documentElement.clientHeight||this.win.innerHeight);this.geometryKey='';
    } else if(!this.cycle&&!editing&&!this.motion&&(this.baseHeight-height<80||Math.abs(height-layoutHeight)<2))this.baseHeight=height;
    this.width=width;this.visibleHeight=height;
    const gap=Math.max(0,this.baseHeight-height);
    const keyboard=Math.abs((viewport?.scale||1)-1)<.02&&(this.cycle||editing&&gap>80);
    if(keyboard&&gap>80)this.cycle=true;
    const key=[height,top,width,this.baseHeight,keyboard].join(':');if(key===this.key)return;this.key=key;
    const workspace=this.$('workspace');
    // The page and header keep their resting height throughout a keyboard cycle.
    const base=this.baseHeight+'px';if(workspace.style.height!==base)workspace.style.height=base;
    if(top!==this.top||!workspace.style.top){workspace.style.top=top+'px';this.top=top;}
    workspace.style.setProperty('--app-height',height+'px');this.$('login').style.setProperty('--app-height',height+'px');
    workspace.classList.toggle('keyboardOpen',keyboard&&gap>0);
    const limit=Math.max(44,Math.min(this.baseHeight*.22,180,height-145));
    if(limit!==this.promptLimit){this.promptLimit=limit;this.onLimit();}
    if(!this.geometryKey||previousBase!==this.baseHeight)this.geometry();
    // Keep resting safe-area padding constant. Only translate the composer,
    // deducting that padding so its visible edge ends 6px above the keyboard.
    // Start following early viewport samples too; waiting for the keyboard
    // detection threshold would make the first visible movement jump.
    const target=keyboard||editing?Math.max(0,gap-Math.max(0,this.dockPadding-6)):0;
    this.move(target);
  }
  geometry() {
    if(this.$('workspace').hidden)return;
    const dock=this.$('composerDock'),height=dock.offsetHeight,padding=parseFloat(this.win.getComputedStyle(dock).paddingBottom)||0;
    if(!height)return;
    const top=this.$('chatViewport').offsetTop,key=[height,padding,top,this.baseHeight].join(':');
    if(key===this.geometryKey)return;this.geometryKey=key;
    const scroll=this.$('chatScroll'),position=scroll.scrollTop,follow=this.focusFollow??this.followsChat();
    const paddingChanged=padding!==this.dockPadding;
    this.dockHeight=height;this.dockPadding=padding;this.chatTop=top;this.chatHeight=Math.max(0,this.baseHeight-top-height);
    // Glass underlays add equal padding to the painted scroll surface. Its
    // scroll range and content coordinates remain the same as the logical
    // reading window above, including during the existing keyboard motion.
    this.$('workspace').style.setProperty('--chat-header-height',top+'px');
    this.$('workspace').style.setProperty('--chat-dock-height',height+'px');
    this.$('workspace').style.setProperty('--chat-dock-padding',padding+'px');
    if(this.motion&&!this.motion.manual){
      this.motion.vacancy=Math.max(0,this.chatHeight-this.motion.natural);
      const maximum=Math.max(0,this.motion.natural-this.chatHeight);
      this.motion.compensation=Math.min(this.motion.position,maximum)-this.motion.position;
      scroll.style.height=this.chatHeight+'px';scroll.scrollTop=this.motion.follow?maximum:Math.min(this.motion.position,maximum);
    }
    this.apply(this.lift);
    if(!this.motion||this.motion.manual)this.commit({position,follow});
    if(paddingChanged&&this.cycle){this.key='';this.schedule();}
  }
  prepare() {
    const scroll=this.$('chatScroll'),content=this.doc.querySelector('.chatContent');
    const position=scroll.scrollTop,follow=!this.$('workspace').classList.contains('draftView')&&(this.focusFollow??this.atBottom(2));
    this.focusFollow=null;
    const natural=content.scrollHeight||scroll.scrollHeight,maximum=Math.max(0,natural-this.chatHeight);
    this.motion={follow,position,natural,manual:false,startLift:this.lift,vacancy:Math.max(0,this.chatHeight-natural),compensation:Math.min(position,maximum)-position};
    this.readingLocked=!follow;
    // One full-size scroll surface is clipped by its own viewport during motion.
    // Old messages retain their screen coordinates; pinned content alone moves.
    scroll.style.height=this.chatHeight+'px';scroll.scrollTop=follow?maximum:Math.min(position,maximum);
    this.$('workspace').classList.add('keyboardMoving');this.$('workspace').dataset.keyboardMotion='moving';
    this.apply(this.lift);
  }
  contentChanged() {
    if(!this.motion?.follow||this.motion.manual)return;
    // A stream may lengthen a short reply while the keyboard is moving.
    // Reconcile only on content changes, not on every keyboard frame.
    const natural=this.doc.querySelector('.chatContent').scrollHeight;
    if(natural===this.motion.natural)return;
    this.motion.natural=natural;this.motion.vacancy=Math.max(0,this.chatHeight-natural);
    this.$('chatScroll').scrollTop=Math.max(0,natural-this.chatHeight);this.apply(this.lift);
  }
  apply(lift) {
    this.lift=lift;
    this.$('composerDock').style.transform=lift?'translateY(-'+lift+'px)':'';
    this.$('chatViewport').style.marginBottom=(this.dockHeight+lift)+'px';
    if(this.motion&&!this.motion.manual){
      const shift=this.motion.follow?-Math.max(0,lift-this.motion.vacancy):this.motion.compensation*Math.min(1,lift/Math.max(1,this.motion.startLift));
      this.doc.querySelector('.chatContent').style.transform=shift?'translateY('+shift+'px)':'';
    }
    this.onScrollState();
  }
  move(target) {
    if(!this.chatHeight)return;
    if(Math.abs(target-this.targetLift)<.5)return;
    const now=this.win.performance.now(),continuous=!!this.motion&&now-(this.lastMove||0)<90;
    this.lastMove=now;this.targetLift=target;
    this.win.clearTimeout(this.settleTimer);this.win.cancelAnimationFrame?.(this.motionFrame);
    if(!this.motion)this.prepare();
    if(this.win.matchMedia?.('(prefers-reduced-motion: reduce)').matches||!this.win.requestAnimationFrame){this.apply(target);this.finish();return;}
    if(continuous){
      // Native keyboard animation already supplies intermediate positions.
      // Follow those directly instead of restarting an easing on every event.
      this.apply(target);this.settleTimer=this.win.setTimeout(()=>this.finish(),100);return;
    }
    const from=this.lift,start=now;
    const frame=time=>{
      const progress=Math.min(1,(time-start)/240),ease=1-Math.pow(1-progress,3);
      this.apply(from+(target-from)*ease);
      if(progress<1)this.motionFrame=this.win.requestAnimationFrame(frame);else this.finish();
    };
    this.motionFrame=this.win.requestAnimationFrame(frame);
  }
  commit(saved=this.motion) {
    if(!this.chatHeight)return;
    const scroll=this.$('chatScroll'),position=saved?.manual?scroll.scrollTop:saved?.position??scroll.scrollTop;
    scroll.style.height=Math.max(0,this.chatHeight-this.lift)+'px';
    this.doc.querySelector('.chatContent').style.transform='';
    const maximum=Math.max(0,scroll.scrollHeight-scroll.clientHeight);
    scroll.scrollTop=saved?.follow&&!saved?.manual?maximum:Math.min(position,maximum);
  }
  finish() {
    this.win.clearTimeout(this.settleTimer);this.win.cancelAnimationFrame?.(this.motionFrame);this.motionFrame=null;
    this.commit();this.motion=null;
    this.onScrollState();
    this.$('workspace').classList.remove('keyboardMoving');this.$('workspace').dataset.keyboardMotion='settled';
    if(this.lift<.5&&!editable(this.doc.activeElement)){
      this.cycle=false;
      if(Math.abs(this.baseHeight-this.visibleHeight)<80){this.baseHeight=this.visibleHeight;this.key='';this.viewport();}
    }
  }
  cancel() {
    this.stopBottomScroll();
    this.win.clearTimeout(this.settleTimer);this.win.cancelAnimationFrame?.(this.motionFrame);
    this.motionFrame=null;this.motion=null;this.focusFollow=null;this.readingLocked=false;
    this.targetLift=this.lift;
    this.doc.querySelector('.chatContent').style.transform='';
    this.$('workspace').classList.remove('keyboardMoving');
    this.geometryKey='';this.key='';
    this.onScrollState();
  }
}
