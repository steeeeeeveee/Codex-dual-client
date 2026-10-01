import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {renderTurnControls} from '../static/turn_controls.mjs';

test('phone pause and continue reflect confirmed owner state and disconnects',t=>{
  const dom=new JSDOM('<button id="stop"></button><button id="resumeTurn"></button><p id="runStatus"></p>');
  const previous=globalThis.document;globalThis.document=dom.window.document;
  t.after(()=>{globalThis.document=previous;dom.window.close();});
  const stop=document.getElementById('stop'),resume=document.getElementById('resumeTurn');
  const state={desktop:{connected:true},turnId:'a',turnControl:{supported:true,canPause:true,activeTurnId:'a',resumableTurnId:null}};
  const render=(extra={})=>renderTurnControls({state,shared:true,newMode:false,busy:false,online:true,...extra});
  render();assert.equal(stop.hidden,false);assert.equal(stop.disabled,false);assert.equal(resume.hidden,true);
  render({online:false});assert.equal(stop.disabled,true);
  state.turnId=null;state.turnControl.resumableTurnId='a';render();
  assert.equal(stop.disabled,true);assert.equal(resume.hidden,false);assert.equal(resume.disabled,false);
  assert.match(document.getElementById('runStatus').textContent,/发送/);
  render({busy:true});assert.equal(resume.disabled,true);
  state.desktop.connected=false;render();assert.equal(resume.disabled,true);
  state.turnControl=null;state.desktop.connected=true;render();assert.equal(stop.disabled,true);assert.equal(resume.hidden,true);
});
