// Compose public transcript rows independently of the DOM. A queue receipt is
// never a running signal; only the desktop's active turn can show thinking.
export function transcriptRows(thread, live, {online=true, connected=true, turnId=null, pending=[]}={}) {
  const turns = new Map((thread?.turns || []).map(turn => [turn.id, turn]));
  for (const turn of live?.turns || []) turns.set(turn.id, turn);
  if (!live?.turns && connected && turnId && !turns.has(turnId)) turns.set(turnId, {id:turnId, status:'inProgress', items:[]});
  const rows = [], nickname = live?.nickname || 'Codex';
  for (const turn of [...turns.values()].slice(-20)) {
    let assistant = null, group = 0;
    const addAssistant = () => {
      assistant = {id:turn.id+':assistant:'+group++, role:'agent', name:nickname, status:'', messages:[]};
      rows.push(assistant);
      return assistant;
    };
    for (const item of turn.items || []) {
      if (item.type === 'userMessage') {
        const text = (item.content || []).filter(part => part.type === 'text').map(part => part.text).join('\n');
        const images=[...(item.content||[]).filter(part=>['image','localImage'].includes(part.type)).map(part=>part.media||{error:'图片正在同步'}),...(item.files||[])];
        if (text||images.length) rows.push({id:turn.id+':'+item.id, role:'user', name:'你', status:'', messages:[{id:item.id,text,...(images.length?{images}:{})}]});
        assistant = null;
      } else if (['agentMessage','plan'].includes(item.type) && item.text) {
        (assistant || addAssistant()).messages.push({id:item.id, text:item.text,...(item.media?{media:item.media}:{})});
      } else if(item.type==='imageGeneration') {
        (assistant||addAssistant()).messages.push({id:item.id,text:'',images:[item.media||{error:item.status==='inProgress'?'图片生成中…':'图片暂不可用'}]});
      }
    }
    const active = turn.status === 'inProgress' || (!live?.turns && turn.id === turnId);
    if (active) {
      const row = assistant || addAssistant();
      row.status = !online ? '连接中断，正在重连' : !connected || live?.connected === false ? '正在同步状态' :
        pending.length ? '等待你回答' : '正在思考';
    }
    if (['failed','interrupted'].includes(turn.status)) rows.push({id:turn.id+':result', role:'error', text:turn.status === 'failed' ? '本轮失败' : '本轮已停止'});
  }
  return rows;
}
