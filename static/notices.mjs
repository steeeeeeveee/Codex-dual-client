// Presentation only: keep transient notices out of the transcript layout.
export class FloatingNotices {
  constructor(doc) {
    this.doc=doc;this.win=doc.defaultView;this.root=doc.getElementById('toastStack');
    this.sources=new Map();this.active=new Map();
  }
  show(text='',kind='notice',source=null) {
    if(source){if(this.sources.get(source)===text)return;this.sources.set(source,text);}
    if(!text||!this.root)return;
    const key=kind+'\0'+text;if(this.active.has(key))return;
    const slot=this.doc.createElement('div');slot.className='toastSlot';
    const clip=this.doc.createElement('div');clip.className='toastClip';
    const card=this.doc.createElement('div');card.className='floatingNotice '+kind;card.textContent=text;
    card.setAttribute('role',kind==='connectionAlert'?'status':'alert');
    clip.append(card);slot.append(clip);this.root.append(slot);this.active.set(key,slot);
    const frame=this.win.requestAnimationFrame?.bind(this.win)||(fn=>this.win.setTimeout(fn,16));
    frame(()=>frame(()=>{if(slot.isConnected)slot.classList.add('toastVisible');}));
    this.win.setTimeout(()=>{
      slot.classList.remove('toastVisible');slot.classList.add('toastLeaving');
      this.win.setTimeout(()=>{slot.remove();if(this.active.get(key)===slot)this.active.delete(key);},340);
    },Math.min(10000,4500+text.length*25));
  }
  clear() {for(const slot of this.active.values())slot.remove();this.active.clear();this.sources.clear();}
}
