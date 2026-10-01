// Native plan and async-question projections. No simulated questions or history writes.
export function nativeTurns(state) {
  if (state?.turnHistory?.kind === 'canonical') {
    const h=state.turnHistory.history;
    const keys=h.islands ? [...new Set(h.islands.flatMap(i=>i.entries.map(e=>e.value)))] : Object.keys(h.entitiesByKey);
    return keys.map(k=>h.entitiesByKey[k]).filter(Boolean);
  }
  return state?.turns ?? [];
}
export const questionId=(item,index)=>JSON.stringify(['request_user_input_async',item.id,index]);
export function questionReplies(item) {
  const parts=item.type==='userMessage'?item.content:item.type==='steeringUserMessage'?item.input:null;
  if(parts?.length!==1||parts[0].type!=='text')return [];
  const text=parts[0].text.trim(), start='<send_user_message_question_reply>', end='</send_user_message_question_reply>';
  if(!text.startsWith(start)||!text.endsWith(end))return [];
  try {const result=JSON.parse(text.slice(start.length,-end.length));return (Array.isArray(result)?result:[result]).filter(r=>typeof r.questionItemId==='string'&&typeof r.answer==='string');}
  catch{return [];}
}
export function asyncQuestions(state, {includePending=true}={}) {
  const turn=nativeTurns(state).findLast(t=>t.status==='inProgress');
  if(!turn)return [];
  const answered=new Set((turn.items??[]).flatMap(item=>{
    if(item.type==='steeringUserMessage'&&item.status!=='accepted'&&(!includePending||item.status!=='pending'))return [];
    return questionReplies(item).map(r=>r.questionItemId);
  }));
  return (turn.items??[]).filter(i=>i.type==='agentMessage').flatMap(item=>(item.questions??[]).flatMap((q,index)=>{
    const id=questionId(item,index);
    return answered.has(id)?[]:[{id,sourceItemId:item.id,turnId:turn.turnId??turn.id,question:q.title,options:(q.options??[]).map(label=>({label,description:''})),isOther:true}];
  }));
}
// Runs at the native dispatch boundary for BOTH desktop and phone answers.
// The first inserted pending reply wins. A retry can never cross into another turn.
export function assertAsyncAnswerCurrent(state,input,clientId,expectedTurnId) {
  const replies=questionReplies({type:'userMessage',content:input});
  if(!replies.length)return;
  const turn=nativeTurns(state).findLast(t=>t.status==='inProgress');
  if(!turn||(turn.turnId??turn.id)!==expectedTurnId)throw Error('Question expired');
  const ids=new Set(asyncQuestions(state,{includePending:false}).map(q=>q.id));
  const items=turn.items??[], own=items.findIndex(i=>i.clientUserMessageId===clientId);
  const earlier=new Set(items.flatMap((i,index)=>i.type==='steeringUserMessage'&&i.status==='pending'&&i.clientUserMessageId!==clientId&&(own<0||index<own)?questionReplies(i).map(r=>r.questionItemId):[]));
  if(replies.some(r=>!ids.has(r.questionItemId)||earlier.has(r.questionItemId)))throw Error('Question expired or already answered');
}
export function planRequest(state) {
  // Desktop creates and resolves this request itself when a native plan completes.
  const request=state?.requests?.findLast(r=>r.method==='item/plan/requestImplementation');
  if(!request||typeof request.params.planContent!=='string'||!request.params.planContent.trim())return null;
  const turn=nativeTurns(state).find(t=>(t.turnId??t.id)===request.params.turnId);
  if(!turn||turn.status!=='completed')return null;
  return {id:String(request.id),turnId:request.params.turnId,text:request.params.planContent};
}
