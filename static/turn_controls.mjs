export function renderTurnControls({state,shared,newMode,busy,online}) {
  const stop=document.getElementById('stop'), resume=document.getElementById('resumeTurn');
  resume.hidden=true;
  if(newMode)return;
  if(!shared)return;
  const view=state.turnControl;
  stop.hidden=false;stop.textContent='暂停思考';
  stop.disabled=busy||!online||!state.desktop?.connected||!view?.supported||!view.canPause||!state.turnId;
  resume.hidden=!view?.resumableTurnId;
  resume.disabled=busy||!online||!state.desktop?.connected||!!state.turnId;
  if(view?.resumableTurnId)document.getElementById('runStatus').textContent='本次思考已暂停。可以继续本次任务，或输入新消息发送。';
  else if(!view?.supported&&state.desktop?.connected)document.getElementById('runStatus').textContent+=' 更新兼容桌面后可暂停思考。';
}
