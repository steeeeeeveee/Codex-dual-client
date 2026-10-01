// A floating control only: it never sends messages or changes conversations.
export class ScrollBottom {
  constructor(doc,viewport) {
    this.doc=doc;this.win=doc.defaultView;this.viewport=viewport;this.frame=null;
    this.button=doc.getElementById('scrollToBottom');
    // Keep an already-open phone keyboard and the draft's caret in place.
    this.button.addEventListener('pointerdown',event=>{if(event.button===0)event.preventDefault();});
    this.button.onclick=()=>{
      viewport.scrollToBottom();
      if(doc.activeElement===this.button)doc.getElementById('chatScroll').focus({preventScroll:true});
    };
  }
  schedule() {
    if(this.frame!==null)return;
    if(!this.win.requestAnimationFrame){this.update();return;}
    this.frame=this.win.requestAnimationFrame(()=>{this.frame=null;this.update();});
  }
  update() {
    const workspace=this.doc.getElementById('workspace');
    const hidden=workspace.hidden||workspace.classList.contains('draftView')||workspace.classList.contains('panelOpen')||workspace.classList.contains('drawerVisible')||this.viewport.atVisibleBottom();
    if(this.button.hidden===hidden)return;
    this.button.hidden=hidden;
    if(hidden&&this.doc.activeElement===this.button)this.doc.getElementById('chatScroll').focus({preventScroll:true});
  }
}
