import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {KeyboardViewport} from '../static/keyboard_viewport.mjs';
import {ScrollBottom} from '../static/scroll_bottom.mjs';

function fixture(t) {
 const dom=new JSDOM(readFileSync(new URL('../static/index.html',import.meta.url),'utf8'),{pretendToBeVisual:true});
 t.after(()=>dom.window.close());const doc=dom.window.document,$=id=>doc.getElementById(id),win=dom.window;
 $('workspace').hidden=false;
 let height=1200,position=0;
 Object.defineProperty($('chatScroll'),'scrollHeight',{get:()=>height});
 Object.defineProperty($('chatScroll'),'clientHeight',{value:500});
 Object.defineProperty($('chatScroll'),'scrollTop',{get:()=>position,set:value=>position=Math.min(value,height-500)});
 const controller=new KeyboardViewport(doc),control=new ScrollBottom(doc,controller);
 return {doc,$,win,controller,control,setHeight:value=>{height=value;}};
}

test('bottom control appears only away from bottom in an active conversation',t=>{
 const {control,$}=fixture(t);control.update();assert.equal($('scrollToBottom').hidden,false);
 $('chatScroll').scrollTop=699;control.update();assert.equal($('scrollToBottom').hidden,true);
 $('chatScroll').scrollTop=600;control.update();assert.equal($('scrollToBottom').hidden,false);
 for(const name of ['draftView','panelOpen','drawerVisible']){
  $('workspace').classList.add(name);control.update();assert.equal($('scrollToBottom').hidden,true);
  $('workspace').classList.remove(name);control.update();assert.equal($('scrollToBottom').hidden,false);
 }
 $('workspace').hidden=true;control.update();assert.equal($('scrollToBottom').hidden,true);
});

test('short replies hide the control; new content exposes it without moving the reader',t=>{
 const {control,$,setHeight}=fixture(t);setHeight(500);control.update();assert.equal($('scrollToBottom').hidden,true);
 setHeight(900);control.update();assert.equal($('scrollToBottom').hidden,false);assert.equal($('chatScroll').scrollTop,0);
});

test('activating the bottom control scrolls without submitting a draft or changing conversation',t=>{
 const {control,controller,$,win,doc}=fixture(t);win.matchMedia=()=>({matches:true});control.update();
 let submits=0,changes=0;$('compose').onsubmit=()=>submits++;$('threads').onchange=()=>changes++;
 $('prompt').value='保留草稿';$('prompt').focus();
 const pointer=new win.MouseEvent('pointerdown',{bubbles:true,cancelable:true,button:0});
 $('scrollToBottom').dispatchEvent(pointer);assert.equal(pointer.defaultPrevented,true);
 $('scrollToBottom').click();control.update();
 assert.equal(doc.activeElement,$('prompt'));assert.equal($('prompt').value,'保留草稿');
 assert.equal(submits,0);assert.equal(changes,0);assert.equal(controller.atBottom(),true);assert.equal($('scrollToBottom').hidden,true);
});
