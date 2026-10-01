// Stop the expected turn, then continue through the desktop's native empty turn.
import {nativeTurns} from './plan_workflow.mjs';
const continuationTurns=new Map();

export function turnControlView(owner,id) {
  const turns=nativeTurns(owner.getConversation(id));
  const latest=turns.findLast(t=>(t.turnId??t.id)!=null);
  const active=owner.turnCoordinator.options.submissionHost.getActiveTurnId(id);
  const activeTurn=turns.findLast(t=>(t.turnId??t.id)===active&&t.status==='inProgress');
  if(continuationTurns.get(id)!==active)continuationTurns.delete(id);
  return {supported:typeof owner.interruptConversation==='function'&&typeof owner.startEmptyTurn==='function',
    activeTurnId:active??null,
    canPause:!!activeTurn&&(!!activeTurn.items?.length||continuationTurns.get(id)===active||activeTurn.params?.turnTrigger==='mobile_resume'),
    resumableTurnId:!active&&latest?.status==='interrupted'?(latest.turnId??latest.id):null};
}

export async function controlTurn(owner,request) {
  const id=request.conversationId, view=turnControlView(owner,id);
  if(!view.supported)throw Error('请更新兼容桌面以使用暂停功能');
  if(typeof request.turnId!=='string'||!request.turnId)throw Error('缺少本轮标识，请刷新');
  if(request.operation==='pause-turn') {
    if(view.resumableTurnId===request.turnId)return {status:'paused',turnId:request.turnId};
    if(view.activeTurnId!==request.turnId)throw Error('本轮已结束或已切换，请刷新');
    if(!view.canPause)throw Error('消息尚在启动，请稍候再暂停');
    // Expected-turn interruption deliberately skips the native goal side effect.
    // Pause an active goal as well so it cannot launch another automatic turn.
    if(owner.getConversation(id)?.threadGoal?.status==='active') {
      const {goal}=await owner.sendRequest('thread/goal/set',{threadId:id,status:'paused'});
      owner.updateConversationState(id,state=>{state.threadGoal=goal;state.threadGoalResumeConfirmation=null;});
    }
    const interrupted=await owner.interruptConversation(id,'user-stop',request.turnId);
    if(interrupted!==request.turnId)throw Error('本轮已结束，请刷新确认');
    return {status:'paused',turnId:interrupted};
  }
  if(request.operation==='resume-turn') {
    if(view.activeTurnId||view.resumableTurnId!==request.turnId)throw Error('暂停任务已改变，请刷新');
    // The native path retains context and respects the current collaboration mode.
    // Empty input resumes work without fabricating a user message.
    await owner.startEmptyTurn(id,{continuationInput:[],turnTrigger:'mobile_resume'});
    const resumed=owner.turnCoordinator.options.submissionHost.getActiveTurnId(id);
    if(resumed)continuationTurns.set(id,resumed);
    return {status:'resumed',turnId:request.turnId};
  }
  throw Error('Unsupported turn control');
}

export async function resumeQueuedAfterPause(owner,id) {
  if(turnControlView(owner,id).resumableTurnId) {
    // queue/add retains the native interrupted pause. A deliberate new message
    // must use the desktop's resume action to start that queue again.
    const queue=owner.turnCoordinator.serverQueue;
    if(!queue?.isEnabled(id))throw Error('Native queue capability unavailable');
    await queue.load(id);
    const first=queue.read(id)?.[0];
    if(first)await owner.sendRequest('thread/queue/start',{threadId:id,queuedSubmissionId:first.id});
    await queue.load(id);
  }
}
