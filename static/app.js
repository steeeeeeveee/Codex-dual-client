'use strict';
import {transcriptRows} from './transcript.mjs';
import {effortLabel,selectionForModel,newestSettings} from './settings.mjs';
import {renderMessageBody} from './markdown.mjs';
import {UsageController} from './usage.mjs';
import {MobileShell,setText} from './shell.mjs';
import {renderTurnControls} from './turn_controls.mjs';
import {ImageComposer} from './image_composer.mjs';
import {imageFigure} from './media.mjs';
const $ = id => document.getElementById(id);
const usage = new UsageController($('usageCard'), api);
const ui = new MobileShell();
const scroller = () => $('chatScroll');
let selected = sessionStorage.getItem('selectedThread')||'', cursor = null, current = {}, busy = false, polling = false, lastQuestionKey = '', lastLiveKey = '', historyIds = new Set(), wasRunning = false;
const drafts = {};
try{Object.assign(drafts,JSON.parse(localStorage.getItem('conversationTextDrafts'))||{});}catch{}
function saveThreadDrafts(){try{localStorage.setItem('conversationTextDrafts',JSON.stringify(drafts));}catch{notice('本机空间不足，文字草稿暂未保存；请保持页面打开。');}}
function pendingSend(tid){try{const value=JSON.parse(localStorage.getItem('lastSend:'+tid)||localStorage.getItem('lastSend'));return value?.payload?.threadId===tid?value:null;}catch{return null;}}
function savePendingSend(value){localStorage.setItem('lastSend:'+value.payload.threadId,JSON.stringify(value));}
function clearPendingSend(tid){localStorage.removeItem('lastSend:'+tid);try{if(JSON.parse(localStorage.getItem('lastSend'))?.payload?.threadId===tid)localStorage.removeItem('lastSend');}catch{}}
let lastQueueKey='', lastSharedHistory='', openingDesktop=null;
let eventSource=null, eventThread='', liveTranscript=null, streamOnline=true, serviceOnline=true;
let transcriptFrame=0;
const messageNodes=new Map();
let capabilities={models:[],projects:[]}, capabilitiesAt=0, newMode=sessionStorage.getItem('newConversation')==='1'||!selected, settingsBase=null, settingsDirty=false, creationRequest=null, creationRows=[], creationKey='';
try{creationRequest=JSON.parse(localStorage.getItem('newCreationRequest'));}catch{}
if(newMode){selected='';sessionStorage.setItem('newConversation','1');}
const creationLocked=()=>newMode&&!!creationRequest;
const images=new ImageComposer(document,{api,ui,notice,changed:()=>controls()});
function saveNewDraft(){if(newMode&&!creationRequest)localStorage.setItem('newConversationDraft',JSON.stringify({text:$('prompt').value,project:$('project').value,model:$('model').value,effort:$('effort').value,mode:$('conversationMode').value}));else if(!newMode&&selected){drafts[selected]=$('prompt').value;saveThreadDrafts();}}
function fillEfforts(wanted) {
  const model=$('model').value, entry=capabilities.models.find(item=>item.id===model);
  $('effort').replaceChildren();
  if(!model){$('effort').append(new Option('沿用桌面默认',''));return;}
  for(const item of entry?.efforts||[])$('effort').append(new Option(effortLabel(item.id),item.id));
  const selection=selectionForModel(capabilities.models,model,wanted);
  if(selection.valid)$('effort').value=selection.effort;
  else{$('effort').append(new Option('选项已失效，请重新选择',''));$('effort').value='';}
  return selection;
}
function fillModels(model,effort) {
  $('model').replaceChildren();
  if(newMode)$('model').append(new Option('沿用桌面默认',''));
  for(const item of capabilities.models)$('model').append(new Option(item.name,item.id));
  if(model&&!capabilities.models.some(item=>item.id===model))$('model').append(new Option(model+'（当前不可用）',model));
  $('model').value=model||'';fillEfforts(effort);
}
async function loadCapabilities() {
  const result=await api('capabilities');capabilitiesAt=Date.now();
  const changed=JSON.stringify(capabilities.models)!==JSON.stringify(result.models), project=$('project').value;
  capabilities=result;capabilities.models??=[];capabilities.projects??=[];
  const upgradeText={
    'waiting-exit':'新版桌面已准备好，等待当前任务结束并切换。图片消息会保留，更新完成后自动转交。',
    launching:'正在启动新版兼容桌面，请稍候。',
    failed:'新版桌面尚未确认启动成功，已保留创建请求。请在电脑检查兼容桌面。',
    expired:'升级等待已到期，当前版本继续保留；请在电脑重新安排升级。'
  }[capabilities.upgrade?.status];
  $('upgradeNotice').textContent=upgradeText||'';$('upgradeNotice').hidden=!upgradeText;
  const projects=[['','独立对话'],...capabilities.projects.map(item=>[item.id,item.name])];
  if(project&&!capabilities.projects.some(item=>item.id===project))projects.push([project,'原项目已不可用']);
  if(JSON.stringify([...$('project').options].map(option=>[option.value,option.textContent]))!==JSON.stringify(projects))
    $('project').replaceChildren(...projects.map(([value,label])=>new Option(label,value)));
  $('project').value=project;
  if(changed||!$('model').options.length)fillModels($('model').value||settingsBase?.next.model,$('effort').value||settingsBase?.next.effort);
  renderSettings();
}
function syncUI(){ui.sync({newMode,selected,current,busy,settingsBase,settingsDirty,capabilities,serviceOnline,streamOnline,creationRequest,creationRows});const uncertain=!newMode&&['needs-review','checking'].includes(pendingSend(selected)?.status);$('prompt').readOnly=uncertain;images.context(newMode?'new':selected,creationLocked()||busy||uncertain);if(!images.ready)$('send').disabled=true;}
function renderSettings(sync=true) {
  const shared=isShared();$('newLocation').hidden=!newMode;$('modelControls').hidden=!(newMode||shared);
  $('applySettings').hidden=newMode;
  setText($('promptLabel'),newMode?'首条消息':'发送到当前对话');
  const value=shared?newestSettings(newestSettings(current.settings,liveTranscript?.connected?liveTranscript.settings:null),settingsBase):null;
  if(value&&value.version!==settingsBase?.version){
    if(settingsDirty)notice('设置已在电脑更新，已刷新为电脑的最新设置。请重新选择后应用。');
    settingsBase=value;settingsDirty=false;fillModels(value.next.model,value.next.effort);$('conversationMode').value=value.next.mode||'default';
  }else if(value)settingsBase=value;
  const pending=shared&&current.settingsOperation?.status==='uncertain';
  const editable=newMode||!!(serviceOnline&&current.desktop?.connected&&capabilities.desktop?.connected&&capabilities.settings&&settingsBase);
  $('model').disabled=busy||creationLocked()||!editable;
  $('effort').disabled=$('model').disabled||!$('model').value;
  $('project').disabled=busy||creationLocked();
  const valid=!$('model').value&&newMode||selectionForModel(capabilities.models,$('model').value,$('effort').value).valid;
  $('applySettings').disabled=busy||!editable||!settingsDirty||pending||!valid;
  const planReady=newMode?!!capabilities.planMode:!!current.planMode;
  $('conversationMode').disabled=busy||creationLocked()||!editable||pending||!planReady;
  setText($('nativeModeHint'),!planReady?'计划模式需要新版兼容桌面，更新完成后自动启用。':newMode?'计划模式先澄清需求、提出方案；采用后再实施。':`已确认：${settingsBase?.next.mode==='plan'?'计划模式':'执行模式'}。${settingsDirty?'模式选择尚未应用。':'计划模式先澄清需求、提出方案，等待你决定是否采用。'}`);
  const label=value=>value?`${value.mode==='plan'?'计划模式 · ':value.mode==='default'?'执行模式 · ':''}${capabilities.models.find(model=>model.id===value.model)?.name||value.model||'桌面默认'} · ${effortLabel(value.effort)||'默认'}`:'等待桌面确认';
  if(newMode){
    const defaults=$('project').value?capabilities.projectDefaults?.[$('project').value]:capabilities.defaults;
    setText($('settingsStatus'),'新对话设置');
    setText($('settingsHint'),capabilities.stale?'电脑离线，显示上次可用选项。创建请求可先保存，连接后重新校验。':$('model').value?`创建后使用：${label({model:$('model').value,effort:$('effort').value})}`:`沿用桌面默认${defaults?.model?'：'+label(defaults):''}。创建时以电脑最新设置为准。`);
  }
  else{
    const s=settingsBase;
    setText($('settingsStatus'),s?(s.current&&JSON.stringify([s.current.model,s.current.effort,s.current.mode])!==JSON.stringify([s.next.model,s.next.effort,s.next.mode])?`本轮：${label(s.current)}；后续：${label(s.next)}`:`后续轮次：${label(s.next)}`):'等待桌面读取设置');
    setText($('settingsHint'),pending?'设置结果待核对，暂不能再次修改。':!editable?'电脑未连接或桌面需要更新，设置暂不能应用。':settingsDirty?'尚未应用。发送仍使用桌面已确认的设置。':'应用后，之后启动的轮次（包括队列中的消息）使用新设置；当前回复保持不变。');
  }
  if(sync)syncUI();
}
async function selectConversation(tid) {
  images.closeMenu();
  ui.closeAll();
  stopStream();messageNodes.clear();if(selected){drafts[selected]=$('prompt').value;saveThreadDrafts();}
  newMode=false;sessionStorage.removeItem('newConversation');selected=tid;sessionStorage.setItem('selectedThread',selected);
  settingsBase=null;settingsDirty=false;current={};$('conversationMode').value='default';$('planReview').hidden=true;$('prompt').value=pendingSend(selected)?.payload.text??drafts[selected]??'';
  historyIds.clear();lastQuestionKey='';lastLiveKey='';lastSharedHistory='';lastQueueKey='';
  $('history').replaceChildren();$('live').replaceChildren();$('questions').replaceChildren();
  if(![...$('threads').options].some(o=>o.value===tid))$('threads').append(new Option('新对话',tid));
  $('threads').value=tid;await loadHistory();
}
async function beginNew() {
  images.closeMenu();
  ui.closeAll();
  if(selected){drafts[selected]=$('prompt').value;saveThreadDrafts();}
  stopStream();newMode=true;selected='';settingsBase=null;settingsDirty=false;current={};
  sessionStorage.setItem('newConversation','1');sessionStorage.removeItem('selectedThread');$('threads').value='';
  $('history').replaceChildren();$('live').replaceChildren();$('questions').replaceChildren();
  await loadCapabilities();
  let draft={};try{draft=JSON.parse(localStorage.getItem('newConversationDraft'))||{};}catch{}
  if(creationRequest)draft={...creationRequest,text:creationRequest.text,project:creationRequest.target.projectId||''};
  $('prompt').value=draft.text||'';
  if(draft.project&&![...$('project').options].some(o=>o.value===draft.project))$('project').append(new Option('上次选择的项目',draft.project));
  $('project').value=draft.project||'';$('conversationMode').value=draft.mode||'default';$('planReview').hidden=true;fillModels(draft.model||'',draft.effort);controls();
  $('compose').scrollIntoView({behavior:'smooth'});
}
async function pollCreations() {
  creationRows=(await api('threads/requests')).data;
  const key=JSON.stringify(creationRows);
  if(key!==creationKey){creationKey=key;$('creations').replaceChildren();
    const visible=creationRows.filter(r=>r.status!=='cancelled').slice(0,5);$('creationCard').hidden=!visible.length;
    for(const row of visible){
      const box=node('article',undefined,'creationItem');box.append(node('p',row.text.slice(0,90)));
      const labels={waiting:'已保存到电脑服务 · 等待电脑创建',checking:'正在由电脑创建',created:'已创建 · 正在转交首条消息',complete:'已创建',invalid:'选项已失效，请重新选择','needs-review':'创建结果待核对'};
      const messageStatus={waiting:'首条消息等待转交',checking:'首条消息正在转交','needs-review':'首条消息结果待核对',queued:'首条消息已入队',executed:'首条消息已开始执行','accepted-earlier':'首条消息已由电脑接收'}[row.messageStatus];
      box.append(node('p',(row.reason||labels[row.status]||row.status)+(messageStatus?' · '+messageStatus:''),'muted'));
      if(row.threadId){const open=node('button','打开对话','secondary');open.type='button';open.onclick=()=>run(()=>selectConversation(row.threadId));box.append(open);}
      if(row.status==='waiting'){const cancel=node('button','撤回创建','secondary');cancel.type='button';cancel.onclick=()=>run(async()=>{await api('threads/cancel',{requestId:row.requestId});if(creationRequest?.requestId===row.requestId){creationRequest=null;localStorage.removeItem('newCreationRequest');saveNewDraft();}});box.append(cancel);}
      if(row.status==='invalid'){const restore=node('button','重新选择','secondary');restore.onclick=()=>run(async()=>{creationRequest=null;localStorage.removeItem('newCreationRequest');localStorage.setItem('newConversationDraft',JSON.stringify({text:row.text,project:row.target.projectId||''}));await beginNew();});box.append(restore);}
      $('creations').append(box);
    }
  }
  const active=creationRows.find(r=>r.requestId===creationRequest?.requestId);
  if(active?.status==='complete'&&active.threadId){
    creationRequest=null;localStorage.removeItem('newCreationRequest');localStorage.removeItem('newConversationDraft');await images.clear('new');
    if(newMode){await selectConversation(active.threadId);notice('对话已在电脑创建，首条消息交由共享队列处理。');}
  }
}
const isShared = () => current.mode==='shared' && current.threadId===selected;
function stopStream() {
  if(transcriptFrame)cancelAnimationFrame(transcriptFrame);transcriptFrame=0;
  eventSource?.close();eventSource=null;eventThread='';liveTranscript=null;streamOnline=true;
}
function watchStream() {
  if(!isShared()){stopStream();return;}
  if(eventThread===selected&&eventSource)return;
  stopStream();const tid=selected;eventThread=tid;
  const source=eventSource=new EventSource('/api/events?threadId='+encodeURIComponent(tid));
  source.addEventListener('transcript',event=>{
    if(source!==eventSource||tid!==selected)return;
    try{const value=JSON.parse(event.data);if(value.threadId!==tid)return;liveTranscript=value;streamOnline=true;
      if(!transcriptFrame)transcriptFrame=requestAnimationFrame(()=>{transcriptFrame=0;if(source!==eventSource||tid!==selected)return;renderSharedHistory();renderSettings();});
    }catch{}
  });
  source.onerror=()=>{if(source!==eventSource)return;streamOnline=false;renderSharedHistory();controls();};
}
function placeChildren(parent, children) {
  children.forEach((child,index)=>{if(parent.children[index]!==child)parent.insertBefore(child,parent.children[index]||null);});
  while(parent.children.length>children.length)parent.lastElementChild.remove();
}
function renderSharedHistory() {
  if(!isShared()||!current.thread)return;
  const thread=current.thread;
  const rows=transcriptRows(thread,liveTranscript,{online:streamOnline,connected:current.desktop?.connected,turnId:current.turnId,pending:current.pending||[]});
  const key=JSON.stringify([selected,thread.hasOlder,rows]);
  if(key===lastSharedHistory)return;lastSharedHistory=key;
  const history=$('history'),scroll=scroller(),nearBottom=ui.followsChat(),position=scroll.scrollTop;
  const children=[],used=new Set();
  if(thread.hasOlder){let hint=messageNodes.get('older');if(!hint){hint=node('p','显示最近 20 轮；完整历史仍保留在原对话。','muted');messageNodes.set('older',hint);}children.push(hint);used.add('older');}
  for(const row of rows){
    used.add(row.id);let box=messageNodes.get(row.id);
    if(!box){box=node(row.role==='error'?'p':'article',undefined,row.role==='error'?'turnError':'message'+(row.role==='user'?' user':''));messageNodes.set(row.id,box);}
    if(row.role==='error'){if(box.textContent!==row.text)box.textContent=row.text;children.push(box);continue;}
    if(!box.header){box.header=node('div',undefined,'role');box.name=node('span');box.status=node('span',undefined,'thinking');box.status.setAttribute('role','status');box.header.append(box.name,box.status);box.append(box.header);box.parts=new Map();}
    if(box.name.textContent!==row.name)box.name.textContent=row.name;
    if(box.status.textContent!==row.status)box.status.textContent=row.status;
    box.status.hidden=!row.status;
    const parts=[box.header],partIds=new Set();
    for(const message of row.messages){let body=box.parts.get(message.id);if(!body){body=node('div',undefined,'body');box.parts.set(message.id,body);}renderMessageBody(body,message.text,{rich:row.role==='agent',media:message.media||{},images:message.images||[]});parts.push(body);partIds.add(message.id);}
    for(const id of box.parts.keys())if(!partIds.has(id))box.parts.delete(id);
    placeChildren(box,parts);children.push(box);
  }
  for(const id of messageNodes.keys())if(!used.has(id))messageNodes.delete(id);
  placeChildren(history,children);$('live').replaceChildren();
  $('threadInfo').textContent=(thread.name||'已有对话')+' · 最近对话';
  scroll.scrollTop=nearBottom?scroll.scrollHeight:position;
}
function renderHistory(thread) {
  const turns=thread.turns||[];
  const key=JSON.stringify([selected,turns]);
  if(key===lastSharedHistory)return;
  lastSharedHistory=key;
  const nearBottom=ui.followsChat();
  const position=scroller().scrollTop;
  $('history').replaceChildren();historyIds=new Set();
  if(turns.length>20||thread.hasOlder)$('history').append(node('p','显示最近 20 轮；完整历史仍保留在原对话。','muted'));
  for(const turn of turns.slice(-20)){
    for(const item of turn.items||[]){historyIds.add(item.id);showMessage(item,$('history'));}
    if(['failed','interrupted'].includes(turn.status))$('history').append(node('p',turn.status==='failed'?'本轮失败'+(turn.error?'：'+(turn.error.message||turn.error):''):'本轮已停止','turnError'));
  }
  $('threadInfo').textContent=(thread.name||'已有对话')+' · '+(thread.hasOlder?'最近 ':'')+turns.length+' 轮历史';
  scroller().scrollTop=nearBottom?scroller().scrollHeight:position;
}
function notice(text='',source=null) { $('notice').textContent = text; $('notice').hidden = !text; $('loginError').textContent=$('workspace').hidden?text:'';if(!$('workspace').hidden)ui.notify(text,source); }
async function api(path, body) {
  const r = await fetch('/api/'+path, {method:body===undefined?'GET':'POST', headers:body===undefined?{}:{'Content-Type':'application/json','X-Mobile-Client':'1'}, body:body===undefined?undefined:JSON.stringify(body)});
  const data = await r.json();
  if(r.status===401) { usage.setAuthenticated(false); $('login').hidden=false; $('workspace').hidden=true; }
  if(!r.ok){const error=new Error(typeof data.detail==='string'?data.detail:'请求失败，请检查输入');error.status=r.status;throw error;}
  return data;
}
function node(tag, text, cls) { const el=document.createElement(tag); if(text!==undefined) el.textContent=text; if(cls)el.className=cls; return el; }
function showMessage(item, destination) {
  let text='',role='',pictures=[];
  if(['agentMessage','plan'].includes(item.type)) {text=item.text;role='Codex';}
  if(item.type==='userMessage') {text=(item.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('\n');pictures=[...(item.content||[]).filter(c=>['image','localImage'].includes(c.type)).map(c=>c.media||{error:'图片正在同步'}),...(item.files||[])];role='你';}
  if(item.type==='imageGeneration'){role='Codex';pictures=[item.media||{error:'图片正在同步'}];}
  if(!text&&!pictures.length)return;
  const box=node('article',undefined,'message'+(role==='你'?' user':''));
  const body=node('div',undefined,'body');renderMessageBody(body,text,{rich:role==='Codex',media:item.media||{},images:pictures});
  box.append(node('div',role,'role'),body);destination.append(box);
}
async function loadThreads(more=false) {
  const result=await api('threads'+(more&&cursor?'?cursor='+encodeURIComponent(cursor):''));
  if(!more){$('threads').replaceChildren(new Option('请选择已有对话',''));}
  for(const t of result.data){const o=new Option(t.name||t.preview||t.id,t.id);o.title=t.cwd||'';$('threads').append(o);}
  cursor=result.nextCursor; $('more').hidden=!cursor;
  if(selected){if(![...$('threads').options].some(o=>o.value===selected))$('threads').append(new Option('上次选择的对话',selected));$('threads').value=selected;}
  ui.renderThreads(selected,busy);
}
async function loadHistory() {
  if(!selected)return;
  const tid=selected;
  const result=await api('thread/'+encodeURIComponent(tid));
  if(tid!==selected)return;
  if(result.mode==='shared'){if(isShared()){current.thread=result.thread;renderSharedHistory();}else renderHistory(result.thread);return;}
  $('history').replaceChildren(); historyIds=new Set();
  const turns=result.thread.turns||[];
  const visible=turns.slice(-20);
  if(turns.length>20)$('history').append(node('p','显示最近 20 轮；Codex 续接保留完整上下文。','muted'));
  for(const turn of visible)for(const item of turn.items||[]){historyIds.add(item.id);showMessage(item,$('history'));}
  $('threadInfo').textContent=(result.thread.name||'已有对话')+' · '+turns.length+' 轮历史';
  scroller().scrollTop=scroller().scrollHeight;
  lastLiveKey=''; renderLive();
}
function controls(){try{businessControls();}finally{syncUI();}}
function businessControls() {
  const shared=isShared();
  $('resumeTurn').hidden=true;
  renderSettings(false);renderPlanReview();for(const b of $('questions').querySelectorAll('button'))b.disabled=busy||!serviceOnline||(isShared()&&!current.desktop?.connected);$('prompt').disabled=creationLocked();$('newThread').disabled=busy;
  if(newMode){
    $('serviceInfo').textContent='新对话草稿 · 手机 v0.12.3';$('handoff').hidden=true;$('queueCard').hidden=true;$('planControl').hidden=true;$('stop').hidden=true;
    setText($('send'),creationRequest?'核对创建请求':'创建并发送');$('send').disabled=busy;
    $('runStatus').textContent=creationRequest?'请求编号已保留；重复点击只核对同一请求，不会创建第二份。':'草稿保存在此浏览器。点击创建并发送后，收到服务确认才算保存到电脑。';
    $('modeHint').textContent='选择电脑已有项目或独立对话。创建完成后可在两端继续聊天。';return;
  }
  $('serviceInfo').textContent=shared?(current.desktop?.connected?'双端已连接 · 可共同发送 · 手机 v0.12.3':'双端共用 · 此对话未连接电脑 · 手机 v0.12.3'):current.serviceMode==='shared'?'双端共用模式 · 请选择对话 · 手机 v0.12.3':'交替接管模式 · 手机 v0.12.3';
  $('handoff').hidden=shared;$('queueCard').hidden=!shared;$('planControl').hidden=shared;$('stop').hidden=shared;
  setText($('send'),shared?'加入队列':'发送');
  $('modeHint').textContent=shared?'首次使用需从原版切换到“Codex 双端共用”。切换成功后，兼容桌面保持打开，电脑和手机可共同发送。计划模式可在下方设置并与电脑同步；队列编辑沿用电脑操作。':'交替操作：接管前先结束电脑中的工作。若提示占用，请完全退出桌面 Codex。手机交还后再打开桌面。';
  if(shared){
    $('openDesktop').hidden=!current.canOpenDesktop;
    $('openDesktop').disabled=busy||openingDesktop?.threadId===selected;
    $('openDesktop').textContent=openingDesktop?.threadId===selected?'正在核对连接…':current.desktop?.connected?'检查电脑连接':'在电脑连接此对话';
    $('desktopState').textContent=current.desktop?.connected?'电脑已连接 · 可共同发送':(current.desktop?.reason||'等待电脑');
    $('send').disabled=busy;
    $('runStatus').textContent=current.desktop?.connected?(current.turnId?'电脑正在执行，可继续加入队列。':'电脑已连接，发送后由电脑执行。'):(current.desktop?.reason||'等待电脑连接')+'。发送内容会先保存在服务中。';
    renderTurnControls({state:current,shared,newMode,busy,online:serviceOnline&&streamOnline});
    if(current.turnControl?.resumableTurnId)$('send').textContent='发送新消息';
    return;
  }
  const owned=current.threadId===selected&&!!selected;
  $('takeover').disabled=!selected||!!current.threadId||busy;
  $('release').disabled=!owned||!!current.turnId||!!current.pending?.length||busy;
  $('send').disabled=!owned||!!current.turnId||busy;
  $('stop').disabled=!owned||!current.turnId||busy;
  $('runStatus').textContent=owned?(current.turnId?'Codex 正在执行。可离开此页，回来后自动恢复。':'手机已接管。可继续这个对话。'):'接管后可以发送。';
}
function renderDesktopLaunch() {
  if(!openingDesktop||openingDesktop.threadId!==selected)return;
  const launched=current.desktopLaunch;
  let message;
  if(current.desktop?.connected)message='电脑已连接。兼容桌面保持打开，现在可在两端共同发送。';
  else if(launched?.requestId===openingDesktop.requestId&&launched.status==='failed')message='兼容桌面启动失败，请在电脑打开“Codex 双端共用”后重试。尚未转交的消息仍保留。';
  else if(['original-owner','incompatible'].includes(current.desktop?.code))message=current.desktop.reason;
  else if(performance.now()-openingDesktop.startedAt>20000)message='尚未连接成功。'+(current.desktop?.reason||'请在电脑检查“Codex 双端共用”是否打开了此对话。')+' 已保存的消息继续等待，不会重复发送。';
  if(message){openingDesktop=null;notice(message);}
}
function renderQueue() {
  if(!isShared())return;
  const key=JSON.stringify([current.queue,current.outbox,current.desktop]);
  if(key===lastQueueKey)return;lastQueueKey=key;
  $('desktopQueue').replaceChildren();$('outbox').replaceChildren();
  $('queueCount').textContent=(current.queue||[]).length+' 条';
  $('queueHint').textContent=current.desktop?.connected?'按电脑确认的顺序逐条执行。':'电脑未连接，以下是上次确认的队列；恢复连接后更新。';
  for(const item of current.queue||[]){const li=node('li');li.append(node('div',item.text||'图片消息','queueText'));for(const image of item.images||[])li.append(imageFigure(document,image,image.name));if(item.pausedReason)li.append(node('small','已暂停：'+item.pausedReason));$('desktopQueue').append(li);}
  const queued=new Set((current.queue||[]).map(item=>item.id));
  const pending=(current.outbox||[]).filter(item=>!queued.has(item.id)&&['waiting','checking','needs-review','queued'].includes(item.status));
  if(!current.queue?.length&&!pending.length)$('outbox').append(node('p','暂无待发送消息。','muted'));
  for(const item of pending){
    const card=node('article',undefined,'outboxItem');
    const label={waiting:current.desktop?.connected?'等待转交':'等待电脑',checking:'正在核对', 'needs-review':'结果待核对 · 后续转交已暂停',queued:'电脑已接收 · 正在同步队列'}[item.status];
    card.append(node('strong',label),node('div',item.text||'图片消息','queueText'));for(const image of item.images||[])card.append(imageFigure(document,image,image.name));
    if(item.status==='waiting'){const cancel=node('button','撤回','secondary');cancel.type='button';cancel.onclick=()=>run(()=>api('queue/cancel',{threadId:selected,messageId:item.id}));card.append(cancel);}
    $('outbox').append(card);
  }
}
function renderLive() {
  if(isShared())return;
  const items=current.threadId===selected?(current.items||[]).filter(i=>!historyIds.has(i.id)):[];
  const key=JSON.stringify(items.filter(i=>['agentMessage','userMessage','imageGeneration'].includes(i.type)));
  if(key===lastLiveKey)return;lastLiveKey=key;$('live').replaceChildren();
  items.forEach(i=>showMessage(i,$('live')));
}
function renderQuestions() {
  const pending=(current.pending||[]).filter(m=>m.params?.threadId===selected);
  $('questions').hidden=newMode;
  const approvalItems=(current.items||[]).filter(i=>pending.some(m=>m.params.itemId===i.id));
  const key=JSON.stringify([pending,approvalItems]);
  if(key===lastQuestionKey)return;lastQuestionKey=key;$('questions').replaceChildren();
  for(const msg of pending) {
    const form=node('form',undefined,'card question');const p=msg.params;
    form.append(node('h2',(msg.method.endsWith('requestUserInput')||msg.method==='mobile/asyncQuestion')?'待你回答':'需要你的审批'));
    if((msg.method.endsWith('requestUserInput')||msg.method==='mobile/asyncQuestion')) {
      for(const q of p.questions) {
        form.append(node('h3',q.question));
        for(const option of q.options||[]) {
          const label=node('label',undefined,'option'),input=node('input');input.type='radio';input.name=q.id;input.value=option.label;input.required=true;
          const copy=node('span');copy.append(node('strong',option.label),node('small',option.description));label.append(input,copy);form.append(label);
        }
        if(!q.options?.length||q.isOther){const input=node('input');input.type=q.isSecret?'password':'text';input.name=q.id+'_free';input.setAttribute('aria-label',q.question+(q.options?.length?'：其他回答':''));input.placeholder=q.options?.length?'或输入其他回答':'请输入回答';input.maxLength=10000;if(!q.options?.length)input.required=true;input.addEventListener('input',()=>{for(const radio of form.querySelectorAll('input[type=radio]'))if(radio.name===q.id){radio.required=!input.value;if(input.value)radio.checked=false;}});form.append(input);}
      }
      form.append(node('button','提交答案'));
      form.onsubmit=e=>{e.preventDefault();const data=new FormData(form),answers={};for(const q of p.questions)answers[q.id]=data.get(q.id+'_free')||data.get(q.id)||'';run(()=>api('answer',{threadId:selected,requestId:msg.clientRequestId,answers}));};
    } else {
      if(p.reason||p.message)form.append(node('p',p.reason||p.message));
      if(p.command)form.append(node('pre',p.command));
      if(p.cwd)form.append(node('p','工作目录：'+p.cwd,'muted'));
      if(p.permissions)form.append(node('pre',JSON.stringify(p.permissions,null,2)));
      if(p.networkApprovalContext)form.append(node('pre',JSON.stringify(p.networkApprovalContext,null,2)));
      const changes=(current.items||[]).find(i=>i.id===p.itemId)?.changes;
      if(changes)form.append(node('pre',JSON.stringify(changes,null,2)));
      const isMcp=msg.method==='mcpServer/elicitation/request';
      if(isMcp)form.append(node('p','此类外部表单请交还桌面处理。'));
      let decisions=isMcp?['decline','cancel']:p.availableDecisions||['accept','decline','cancel'];
      if(msg.method==='item/fileChange/requestApproval'&&!changes?.length){decisions=decisions.filter(d=>d!=='accept');form.append(node('p','尚未获取文件改动详情，请在电脑查看并批准。'));}
      if(msg.method==='item/permissions/requestApproval')decisions=['accept','decline'];
      const row=node('div',undefined,'row');
      for(const d of decisions.filter(d=>['accept','decline','cancel'].includes(d))){const b=node('button',({accept:'仅本次允许',decline:'拒绝',cancel:'取消本轮'})[d],d==='accept'?'':'secondary');b.type='button';b.onclick=()=>run(()=>api('answer',{threadId:selected,requestId:msg.clientRequestId,decision:d}));row.append(b);}form.append(row);
    }
    $('questions').append(form);
  }
}

let lastPlanKey='';
function renderPlanReview() {
  const plan=isShared()&&!newMode?current.planReview:null;
  const latest=current.thread?.turns?.at(-1);
  $('planRecoveryHint').hidden=!!plan||!isShared()||newMode||!!current.turnId||!latest?.items?.some(i=>i.type==='plan');
  $('planReview').hidden=!plan;
  if(!plan)return;
  const key=JSON.stringify([selected,plan]);
  if(key!==lastPlanKey){lastPlanKey=key;renderMessageBody($('planReviewBody'),plan.text,{rich:true});}
  const uncertain=current.implementationOperation?.status==='uncertain';
  const waiting=!!current.turnId||!!current.pending?.length||!!current.queue?.length||(current.outbox||[]).some(i=>['waiting','checking','needs-review','queued'].includes(i.status));
  $('implementPlan').disabled=busy||!serviceOnline||!current.desktop?.connected||!current.planMode||uncertain||waiting||settingsDirty;
  $('refinePlan').disabled=busy||uncertain;
  $('planReviewHint').textContent='方案已完成。采用后切换到执行模式；继续完善会保持计划模式。';
  $('planResult').textContent=uncertain?'实施结果待核对，不会重复提交。':waiting?'请先完成待回答问题和队列中的讨论，再采用方案。':settingsDirty?'有尚未应用的设置，请先应用或恢复电脑设置。':!current.desktop?.connected?'电脑未连接，暂不能采用。':'等待你决定；不会自动实施。';
}
$('implementPlan').onclick=()=>run(async()=>{
  const plan=current.planReview, tid=selected;
  if(!plan||!settingsBase)throw Error('方案已更新，请刷新核对。');
  const reference={threadId:tid,version:settingsBase.version,planId:plan.id,turnId:plan.turnId};
  let saved;try{saved=JSON.parse(localStorage.getItem('planImplementation'));}catch{}
  if(!saved||JSON.stringify(saved.reference)!==JSON.stringify(reference)){saved={reference,requestId:crypto.randomUUID(),messageId:crypto.randomUUID()};localStorage.setItem('planImplementation',JSON.stringify(saved));}
  const result=await api('plan/implement',{...reference,requestId:saved.requestId,messageId:saved.messageId});
  if(result.status!=='uncertain')localStorage.removeItem('planImplementation');
  if(tid!==selected)return;
  if(result.settings){settingsBase=result.settings;current.settings=result.settings;settingsDirty=false;fillModels(result.settings.next.model,result.settings.next.effort);$('conversationMode').value=result.settings.next.mode||'default';}
  notice(({applied:'电脑已确认采用，实施消息已交由共享队列处理。',conflict:'方案或设置已在电脑更新，请核对最新方案。',busy:'还有正在执行或排队的消息，请完成后再采用。',unsupported:'当前桌面尚不支持计划确认，请等待更新。',uncertain:'实施结果待核对，不会重复提交。'})[result.status]||'实施结果待核对。');
});
$('refinePlan').onclick=()=>{
  if(settingsBase?.next.mode!=='plan'){notice('请先选择计划模式并应用，再发送完善意见。');$('conversationMode').value='plan';settingsDirty=true;controls();return;}
  $('prompt').focus();$('compose').scrollIntoView({behavior:'smooth'});notice('请输入要调整的内容，再加入队列；对话继续保持计划模式。');
};

async function poll() {
  if(polling)return;polling=true;
  try {
    const tid=selected, next=await api('state'+(tid?'?threadId='+encodeURIComponent(tid):''));
    if(tid!==selected)return;
    const chat=scroller(),height=chat.scrollHeight,visible=chat.clientHeight,follow=ui.followsChat();
    current=next;serviceOnline=true;usage.setAuthenticated(true);$('login').hidden=true;$('workspace').hidden=false;setText($('connection'),'已连接');
    if(!newMode&&!selected&&current.threadId){selected=current.threadId;sessionStorage.setItem('selectedThread',selected);await loadThreads();await loadHistory();}
    watchStream();if(isShared())renderSharedHistory();
    renderLive();renderQuestions();renderPlanReview();renderQueue();renderDesktopLaunch();controls();
    if(follow&&!newMode&&(chat.scrollHeight!==height||chat.clientHeight!==visible))chat.scrollTop=chat.scrollHeight;
    if(isShared()&&current.unsupportedQuestions)notice('电脑上有待处理的表单，请在电脑完成。','unsupportedQuestions');else ui.notify('','unsupportedQuestions');
    if(current.error)notice(current.error,'pollError');else ui.notify('','pollError');
    if(!isShared()&&wasRunning&&!current.turnId&&selected===current.threadId)await loadHistory();
    wasRunning=!!current.turnId;
    if(Date.now()-capabilitiesAt>30000)await loadCapabilities();
    await pollCreations();
  }catch(e){serviceOnline=false;controls();$('connection').textContent=e.status===401?'待登录':'连接中断 · 自动重连';if(e.status===401)stopStream();}finally{polling=false;}
}
async function run(fn) {if(busy)return;busy=true;controls();notice();try{await fn();await poll();}catch(e){notice(e.message);}finally{busy=false;controls();}}
$('loginForm').onsubmit=e=>{e.preventDefault();run(async()=>{await api('login',{password:$('password').value});$('password').value='';await loadThreads();await beginNew();});};
$('threads').onchange=()=>run(()=>selectConversation($('threads').value));
$('newThread').onclick=()=>run(beginNew);
$('model').onchange=()=>{const choice=fillEfforts($('effort').value);settingsDirty=true;if(choice?.changed)notice('原思考强度不受此模型支持，已改选其默认强度：'+effortLabel(choice.effort)+'。'+(newMode?'将在创建时使用。':'点击“应用设置”后生效。'));saveNewDraft();controls();};
$('effort').onchange=()=>{settingsDirty=true;saveNewDraft();controls();};$('project').onchange=()=>{saveNewDraft();renderSettings();};$('prompt').addEventListener('input',saveNewDraft);
$('conversationMode').onchange=()=>{settingsDirty=true;saveNewDraft();controls();};
$('applySettings').onclick=()=>run(async()=>{
  const tid=selected,payload={requestId:crypto.randomUUID(),threadId:tid,version:settingsBase.version,model:$('model').value,effort:$('effort').value,...(current.planMode?{mode:$('conversationMode').value}:{})};
  const result=await api('thread/settings',payload);
  if(tid!==selected)return;
  settingsDirty=result.status==='invalid';
  if(result.settings){settingsBase=result.settings;current.settings=result.settings;fillModels(result.settings.next.model,result.settings.next.effort);$('conversationMode').value=result.settings.next.mode||'default';}
  notice(({applied:'桌面已确认，之后启动的轮次使用新设置。',conflict:'设置已在电脑更新，请重新选择后应用。',invalid:'模型或思考强度已失效，请刷新可用选项并重新选择。',unsupported:'当前桌面不支持原生设置更新，请更新兼容桌面。',uncertain:'设置结果待核对，不会自动重复修改。'})[result.status]||'设置结果待核对');
});
$('refresh').onclick=()=>run(()=>loadThreads());$('more').onclick=()=>run(()=>loadThreads(true));$('historyRefresh').onclick=()=>run(loadHistory);
$('takeover').onclick=()=>run(async()=>{await api('takeover/'+encodeURIComponent(selected),{});await loadHistory();});
$('release').onclick=()=>run(()=>api('release',{}));
$('stop').onclick=()=>run(async()=>{
  if(!isShared())return api('interrupt',{});
  await api('turn/pause',{threadId:selected,turnId:current.turnId});
  notice('已请求暂停，正在核对桌面状态。');
});
$('resumeTurn').onclick=()=>run(async()=>{
  await api('turn/resume',{threadId:selected,turnId:current.turnControl.resumableTurnId});
  notice('桌面已接收继续请求。');
});
$('openDesktop').onclick=()=>run(async()=>{const tid=selected;const result=await api('desktop/open',{threadId:tid});if(result.status==='connected'){openingDesktop=null;notice('电脑已连接，兼容桌面可以保持打开，两端可共同发送。');return;}openingDesktop={threadId:tid,requestId:result.requestId,startedAt:performance.now()};notice('已请求打开兼容桌面，正在核对是否真正连接成功…');});
$('compose').onsubmit=e=>{e.preventDefault();run(async()=>{const text=$('prompt').value;if(!text.trim()&&!images.hasImages)return;if(!images.ready)throw Error('请等待所有附件上传成功，或移除失败的图片。');const attachments=images.ids(),draftKey=newMode?'new':selected;
  if(newMode){
    if(!creationRequest){
      if(new TextEncoder().encode(text).length>32000)throw Error('首条消息最多 32000 字节（约一万汉字），请缩短后重试。');
      if($('model').value&&!capabilities.models.find(m=>m.id===$('model').value)?.efforts.some(e=>e.id===$('effort').value))throw Error('请选择当前模型支持的思考强度。');
      saveNewDraft();creationRequest={requestId:crypto.randomUUID(),messageId:crypto.randomUUID(),target:$('project').value?{type:'project',projectId:$('project').value}:{type:'projectless'},model:$('model').value||null,effort:$('model').value?$('effort').value:null,mode:$('conversationMode').value,text,...(attachments.length?{attachments}:{})};localStorage.setItem('newCreationRequest',JSON.stringify(creationRequest));
    }
    try{const result=await api('threads',creationRequest);notice(({complete:'已创建，正在打开对话。',waiting:'请求已保存到电脑服务，等待桌面创建。',checking:'电脑正在处理创建请求。','needs-review':'创建结果待核对，不会重新创建。',invalid:'选项已失效，请在创建记录中点击“重新选择”。',cancelled:'创建请求已撤回。'})[result.status]||'正在核对原创建请求。');}
    catch(error){throw Error('服务尚未确认，不能确定是否已保存。草稿和请求编号已保留，请重试核对。'+error.message);}
    await pollCreations();return;
  }
  const payload={threadId:selected,text,plan:isShared()?false:$('plan').checked,...(attachments.length?{attachments}:{})};let saved=pendingSend(selected);if(saved&&['needs-review','checking'].includes(saved.status)&&JSON.stringify(saved.payload)!==JSON.stringify(payload))throw Error('上一条消息结果待核对，请先恢复原内容核对，或在队列中确认结果。');if(!saved||JSON.stringify(saved.payload)!==JSON.stringify(payload)){saved={id:crypto.randomUUID(),payload};savePendingSend(saved);}let receipt;try{receipt=await api('send',{id:saved.id,...payload});}catch(error){if(!error.status||error.status>=500){saved.status='checking';savePendingSend(saved);}throw error;}if(['needs-review','checking'].includes(receipt.status)){saved.status=receipt.status;savePendingSend(saved);notice('消息结果待核对，附件、文字和原消息编号已保留；重试只核对原记录。');return;}clearPendingSend(selected);$('prompt').value='';drafts[selected]='';saveThreadDrafts();await images.clear(draftKey);});};
$('logout').onclick=()=>run(async()=>{await api('logout',{});usage.setAuthenticated(false);stopStream();current={};$('login').hidden=false;$('workspace').hidden=true;});
$('fillTest').onclick=()=>{if($('prompt').value.trim()){notice('输入框已有文字，请先保存或清空，再填入测试。');return;}$('plan').checked=!isShared();$('prompt').value=isShared()?'这是手机共享队列连接测试。不要修改文件或调用工具，只回复：手机消息已由电脑执行。':'这是手机网页连接验收。不要改文件、不要运行预约、不要下单、取消或付款。请先根据本对话历史回答：原来的手机班车网页域名是什么？推送通知用的是什么 App？然后调用内置 request_user_input 工具，提出一个问题并提供“选项甲”和“选项乙”两个真实选项，等待我点击。不要用普通文字模拟按钮。收到答案后复述我选了哪个。';$('compose').scrollIntoView({behavior:'smooth'});notice('已填入测试文字；核对后点击发送。');};
document.addEventListener('visibilitychange',()=>{if(!document.hidden)poll();});
(async()=>{$('prompt').value=drafts[selected]||'';try{const saved=pendingSend(selected);if(saved?.payload?.threadId===selected){$('prompt').value=saved.payload.text;$('plan').checked=saved.payload.plan;}}catch{}await poll();if(!$('workspace').hidden)try{await loadThreads();if(newMode)await beginNew();else if(selected)await loadHistory();}catch(e){notice(e.message);}setInterval(poll,1500);})();
