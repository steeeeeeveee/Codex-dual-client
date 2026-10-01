// Included in version-pinned local desktop copies; '*' enables local chats.
import {settingsView, modelCatalog, validateSelection, digestPayload, validId, workflow} from './mobile_settings.mjs';
import {nativeTurns,asyncQuestions,planRequest,assertAsyncAnswerCurrent} from './plan_workflow.mjs';
import {controlTurn,turnControlView,resumeQueuedAfterPause} from './turn_control.mjs';
const allowedThreadId = '__CODEX_MOBILE_TEST_THREAD__';
const lanes = new Map();
const holds = new Map();
const epoch = crypto.randomUUID();
const questionTokens = new Map();
const supportedQuestions = new Set(['item/tool/requestUserInput', 'item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval']);
const fingerprint = value => JSON.stringify([value.id, value.method, value.params]);

function check(owner, id) {
  if (!allowedThreadId || (allowedThreadId !== '*' && id !== allowedThreadId)) throw Error('Lab conversation required');
  if (allowedThreadId === '*' && (!/^[0-9a-f-]{36}$/i.test(id ?? '') || owner.getHostId() !== 'local')) throw Error('Local conversation required');
  owner.assertThreadFollowerOwner(id);
  if (allowedThreadId === '*' && owner.getConversation(id)?.resumeState !== 'resumed') throw Error('Desktop conversation not resumed; waiting for writer');
}
function serial(id, callback) {
  const result = (lanes.get(id) ?? Promise.resolve()).then(callback);
  const settled = result.catch(() => {});
  lanes.set(id, settled);
  settled.finally(() => { if (lanes.get(id) === settled) lanes.delete(id); });
  return result;
}
const journal = (operation, threadId, messageId, receipt) =>
  globalThis.codexMobileLabJournal({ operation, threadId, messageId, receipt });
function message(owner, id, messageId, text, attachments=[]) {
  if (typeof messageId !== 'string' || !/^[0-9a-f-]{36}$/i.test(messageId)) throw Error('Invalid message ID');
  if (typeof text !== 'string' || (!text.trim()&&!attachments.length) || new TextEncoder().encode(text).length > 32000) throw Error('Invalid text');
  const cwd = owner.getConversationCwd(id);
  if (!cwd) throw Error('Conversation workspace unavailable');
  return { id: messageId, text, cwd, createdAt: Date.now(), context: { prompt: text,
    workspaceRoots: [cwd], addedFiles: [],
    fileAttachments: attachments.filter(file=>file.kind==='video').map(file=>({...file,path:file.localPath,fsPath:file.localPath,label:file.filename})),
    imageAttachments: attachments.filter(image=>image.kind!=='video').map(image=>({id:image.id,src:image.localPath,localPath:image.localPath,filename:image.filename})), ideContext: null } };
}

async function submit(owner, request) {
  const { conversationId: id, messageId, text } = request;
  check(owner, id);
  const attachments=request.attachments?.length?await globalThis.codexMobileLabJournal({operation:'media-validate',attachments:request.attachments}):[];
  const item = message(owner, id, messageId, text,attachments);
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(attachments.length?[id,text,attachments]:[id,text])));
  const digest = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
  const previous = await journal('get', id, messageId);
  if (previous && previous.digest !== digest) throw Error('Message ID reused with different content');
  const queue = owner.turnCoordinator;
  await queue.loadMessages(id);
  if (previous) {
    const queued = queue.readMessages(id)?.some(item => (item.clientUserMessageId ?? item.id) === messageId);
    const executed = queue.options.wasMessageAccepted(id, messageId);
    if (queued || executed) await journal('set', id, messageId, { digest, status: 'committed' });
    if(queued)await resumeQueuedAfterPause(owner,id);
    return { messageId, status: queued ? 'queued' : executed ? 'executed'
      : previous.status === 'committed' ? 'accepted-earlier' : 'needs-review' };
  }
  // History can prove a prior commit even if a receipt is unavailable. Missing
  // receipts alone must never be used to recreate an already executed input.
  if (queue.options.wasMessageAccepted(id, messageId)) return { messageId, status: 'executed' };
  if ((await journal('list', id)).some(entry => entry.receipt.status === 'uncertain'))
    throw Error('Earlier submission needs reconciliation');
  await journal('set', id, messageId, { digest, status: 'uncertain' });
  check(owner, id);
  const result = await queue.mobileAppendSingle(id, item);
  await journal('set', id, messageId, { digest, status: 'committed' });
  await resumeQueuedAfterPause(owner,id);
  return { messageId, queueEntryId: result.messageId, status: 'queued' };
}

export function handle(owner, request) {
  return serial(request.conversationId, () => submit(owner, request));
}

export function snapshot(owner, request) {
  return serial(request.conversationId, async () => {
    const id = request.conversationId;
    check(owner, id);
    const queue = owner.turnCoordinator;
    await queue.loadMessages(id);
    if (!queue.serverQueue?.isEnabled(id)) throw Error('Native queue capability unavailable');
    await queue.serverQueue.load(id);
    const revision = owner.getConversationStreamRevision?.(id) ?? null;
    let read;
    if (allowedThreadId === '*') {
      if (revision == null || request.knownRevision !== `${epoch}:${revision}` || owner.getConversation(id)?.requests?.some(item => item.method === 'item/fileChange/requestApproval')) {
        let page;
        try { page = await owner.sendRequest('thread/turns/list', {threadId:id, limit:20, itemsView:'summary', sortDirection:'desc'}); }
        catch (error) {
          // Native creation has a short empty-thread phase before queue/add.
          // It is still owned by this renderer; no history files are fabricated.
          const state = owner.getConversation(id);
          const turns = state?.turnHistory?.kind === 'canonical' ? Object.values(state.turnHistory.history.entitiesByKey) : state?.turns ?? [];
          if (turns.length || !(/is not materialized yet|rollout at .* is empty$/.test(String(error.message)))) throw error;
          page = {data:[],nextCursor:null};
        }
        read = {thread:{turns:[...page.data].reverse(), hasOlder:!!page.nextCursor}};
      }
    } else read = await owner.sendRequest('thread/read', {threadId:id, includeTurns:true});
    check(owner, id);
    const conversation = owner.getConversation(id);
    const requests = [...(conversation?.requests ?? []).filter(r=>r.method!=='item/plan/requestImplementation'),
      ...asyncQuestions(conversation).map(q=>({id:q.id,method:'mobile/asyncQuestion',params:{threadId:id,turnId:q.turnId,questions:[q]}}))];
    for (const [token, value] of questionTokens) {
      if (value.threadId === id && !requests.some(item => fingerprint(item) === value.fingerprint)) questionTokens.delete(token);
    }
    const pending = requests.filter(item => supportedQuestions.has(item.method)||item.method==='mobile/asyncQuestion').map(item => {
      const key = fingerprint(item);
      let token = [...questionTokens].find(([,value]) => value.threadId === id && value.fingerprint === key)?.[0];
      if (!token) { token = epoch + ':' + crypto.randomUUID(); questionTokens.set(token, {threadId:id,fingerprint:key}); }
      return {...item, clientRequestId:token};
    });
    const receipts = await journal('list', id);
    const messages = (queue.readMessages(id) ?? []).map(item => ({id:item.clientUserMessageId ?? item.id, queueEntryId:item.id, text:item.text, pausedReason:item.pausedReason ?? null,
      ...((item.context?.imageAttachments?.length||item.context?.fileAttachments?.length)?{attachments:[...(item.context.imageAttachments??[]),...(item.context.fileAttachments??[])]}: {})}));
    for (const {messageId,receipt} of receipts) {
      if (receipt.status === 'uncertain' && (messages.some(item => item.id === messageId) || queue.options.wasMessageAccepted(id,messageId))) {
        await journal('set', id, messageId, {...receipt, status:'committed'});
      }
    }
    // Proposed plans are parsed into native renderer items. The server's
    // summary history can contain only the original user input for that turn.
    const nativeById=new Map(nativeTurns(conversation).map(t=>[t.turnId??t.id,t]));
    const turns = (read?.thread.turns ?? []).map(turn => {
      const native=nativeById.get(turn.id);
      return {id:turn.id,status:native?.status??turn.status,error:turn.error?.message??null,
        items:(native?.items??turn.items??[]).filter(item=>['userMessage','agentMessage','plan','imageGeneration'].includes(item.type))};
    });
    const requestedItems = new Set(pending.map(item => item.params.itemId));
    const items = (read?.thread.turns ?? []).flatMap(turn => turn.items ?? []).filter(item => requestedItems.has(item.id));
    for (const item of pending) {
      questionTokens.get(item.clientRequestId).hasFileDetails = !!items.find(value => value.id === item.params.itemId)?.changes?.length;
    }
    return {protocol:'mobile-queue-v2', epoch, threadId:id, queue:messages, pending,
      planMode:true, imageInputs:true,imageOutputs:true,videoInputs:true,planReview:planRequest(conversation), turnControl:turnControlView(owner,id),
      settings:settingsView(conversation,queue.options.submissionHost.getActiveTurnId(id)),
      items,
      unsupportedQuestions:requests.filter(item => !supportedQuestions.has(item.method)&&item.method!=='mobile/asyncQuestion').length,
      turnId:queue.options.submissionHost.getActiveTurnId(id),
      revision:revision == null ? null : `${epoch}:${revision}`,
      ...(read ? {thread:{id, name:read.thread.name, turns,hasOlder:read.thread.hasOlder ?? false}} : {}),
      receipts:receipts.map(({messageId,receipt}) => ({messageId, status:messages.some(item => item.id === messageId) ? 'queued' : queue.options.wasMessageAccepted(id,messageId) ? 'executed' : receipt.status === 'committed' ? 'accepted-earlier' : 'needs-review'}))};
  });
}

export function answer(owner, request) {
  const id = request.conversationId;
  check(owner, id);
  const token = questionTokens.get(request.requestId);
  const state=owner.getConversation(id);
  const questions=asyncQuestions(state).map(q=>({id:q.id,method:'mobile/asyncQuestion',params:{threadId:id,turnId:q.turnId,questions:[q]}}));
  const item = token?.threadId === id && [...(state?.requests??[]),...questions].find(item => fingerprint(item) === token.fingerprint);
  if (!item) throw Error('Question expired or already answered');
  const p = item.params;
  if(item.method==='mobile/asyncQuestion') {
    const q=p.questions[0], value=request.answers?.[q.id];
    if(typeof value!=='string'||!value.trim()||value.length>10000)throw Error('Invalid answer');
    const replies=[{questionItemId:q.id,question:q.question,answer:value.trim()}];
    const text='<send_user_message_question_reply>\n'+JSON.stringify(replies)+'\n</send_user_message_question_reply>';
    const messageId=crypto.randomUUID(), restore=message(owner,id,messageId,text);
    questionTokens.delete(request.requestId);
    // A real async question is answered within its originating turn, through
    // the same native steer path as the desktop. Ordinary sends still queue.
    return owner.steerTurn(id,[{type:'text',text,text_elements:[]}],restore,undefined,undefined,messageId,
      undefined,undefined,undefined,undefined,()=>{
        check(owner,id);assertAsyncAnswerCurrent(owner.getConversation(id),[{type:'text',text}],messageId,p.turnId);
      }).then(()=>({ok:true}));
  }
  let payload, method;
  if (item.method === 'item/tool/requestUserInput') {
    const answers = {};
    for (const q of p.questions) {
      const value = request.answers?.[q.id];
      if (typeof value !== 'string' || !value.trim() || value.length > 10000 || (q.options?.length && !q.isOther && !q.options.some(o => o.label === value))) throw Error('Invalid answer');
      answers[q.id] = {answers:[value]};
    }
    payload = {answers}; method = 'replyWithUserInputResponse';
  } else if (['item/commandExecution/requestApproval','item/fileChange/requestApproval'].includes(item.method)) {
    if (!['accept','decline','cancel'].includes(request.decision) || !(p.availableDecisions ?? ['accept','decline','cancel']).includes(request.decision)) throw Error('Invalid decision');
    if (item.method === 'item/fileChange/requestApproval' && request.decision === 'accept' && !token.hasFileDetails) throw Error('File details unavailable; approve on desktop');
    payload = request.decision;
    method = item.method.includes('commandExecution') ? 'replyWithCommandExecutionApprovalDecision' : 'replyWithFileChangeApprovalDecision';
  } else if (item.method === 'item/permissions/requestApproval') {
    if (!['accept','decline'].includes(request.decision)) throw Error('Invalid decision');
    payload = {permissions:request.decision === 'accept' ? p.permissions : {}, scope:'turn'};
    method = 'replyWithPermissionsRequestApprovalResponse';
  } else throw Error('Answer on desktop');
  // No await between checking the current request and the native dispatch.
  // Native handlers remove/resolve it synchronously, also for desktop answers.
  questionTokens.delete(request.requestId);
  owner[method](id, item.id, payload);
  return {ok:true};
}

export function settings(owner, request) {
  return serial(request.conversationId, async () => {
    const id = request.conversationId;
    check(owner,id);
    if(['pause-turn','resume-turn'].includes(request.operation))return controlTurn(owner,request);
    if (!validId(request.requestId)) throw Error('Invalid settings request ID');
    if(['implement-plan','implementation-status'].includes(request.operation))return implementPlan(owner,request);
    const previous = await workflow('get','settings',request.requestId);
    if (request.operation === 'settings-status') return previous ?? {status:'not-received'};
    const digest = await digestPayload([id,request.version,request.model,request.effort,request.mode??null]);
    if (previous) {
      if (previous.digest !== digest) throw Error('Settings request ID reused');
      return previous;
    }
    const models = await modelCatalog((method,params) => owner.sendRequest(method,params));
    try { validateSelection(models,request.model,request.effort); }
    catch { return {status:'invalid'}; }
    if(request.mode!=null&&!['plan','default'].includes(request.mode))return {status:'invalid'};
    const before = settingsView(owner.getConversation(id));
    if (request.version !== before.version) return {status:'conflict',settings:before};
    const claim = await workflow('claim','settings',request.requestId,{digest,status:'uncertain'});
    if (!claim.claimed) return claim.receipt;
    try {
      const applied = await owner.updateThreadSettingsForNextTurn(id,{model:request.model,effort:request.effort,
        ...(request.mode!=null?{collaborationMode:{mode:request.mode,settings:{model:request.model,reasoning_effort:request.effort,developer_instructions:null}}}:{})},
        {ifModelEquals:before.next.model,ifEffortEquals:before.next.effort,mobileSettingsVersion:request.version});
      return await workflow('set','settings',request.requestId,{digest,status:applied?'applied':'conflict',settings:settingsView(owner.getConversation(id))});
    } catch (error) {
      if (owner.threadSettingsUpdateSupport === 'unsupported') return await workflow('set','settings',request.requestId,{digest,status:'unsupported'});
      return {digest,status:'uncertain'};
    }
  });
}

async function implementPlan(owner,request) {
  const id=request.conversationId, previous=await workflow('get','implementation',request.requestId);
  const digest=await digestPayload([id,request.version,request.planId,request.turnId,request.messageId]);
  if(previous) {
    if(request.operation!=='implementation-status'&&previous.digest!==digest)throw Error('Implementation ID reused');
    if(previous.threadId!==id)throw Error('Implementation thread mismatch');
    if(previous.status==='uncertain') {
      await owner.turnCoordinator.loadMessages(id);
      const queued=owner.turnCoordinator.readMessages(id)?.some(m=>(m.clientUserMessageId??m.id)===previous.messageId);
      if(queued||owner.turnCoordinator.options.wasMessageAccepted(id,previous.messageId))
        return workflow('set','implementation',request.requestId,{...previous,status:'applied'});
    }
    return previous;
  }
  if(request.operation==='implementation-status')return {status:'not-received'};
  if(!validId(request.messageId))throw Error('Invalid implementation message ID');
  const queue=owner.turnCoordinator;
  await queue.loadMessages(id);
  const plan=planRequest(owner.getConversation(id)), before=settingsView(owner.getConversation(id));
  if(!plan||plan.id!==request.planId||plan.turnId!==request.turnId||before.version!==request.version)
    return {status:'conflict',settings:before};
  if(queue.options.submissionHost.getActiveTurnId(id)||queue.readMessages(id)?.length||
      owner.getConversation(id).requests.some(r=>r.method!=='item/plan/requestImplementation'))return {status:'busy'};
  const text='PLEASE IMPLEMENT THIS PLAN:\n'+plan.text;
  message(owner,id,request.messageId,text); // Check size before changing any settings.
  const receipt={digest,status:'uncertain',threadId:id,messageId:request.messageId};
  const claim=await workflow('claim','implementation',request.requestId,receipt);
  if(!claim.claimed)return claim.receipt;
  const hold=queue.deferAutomaticTurns(id);
  try {
    const applied=await owner.updateThreadSettingsForNextTurn(id,{collaborationMode:{mode:'default',settings:{
      model:before.next.model,reasoning_effort:before.next.effort,developer_instructions:null}}},
      {ifModelEquals:before.next.model,ifEffortEquals:before.next.effort,mobileSettingsVersion:before.version,
        mobilePlanRequestId:plan.id});
    if(!applied)return workflow('set','implementation',request.requestId,{...receipt,status:'conflict'});
    const now=planRequest(owner.getConversation(id));
    if(!now||now.id!==plan.id||queue.options.submissionHost.getActiveTurnId(id)||queue.readMessages(id)?.length)
      return workflow('set','implementation',request.requestId,{...receipt,status:'conflict'});
    // Native desktop resolves its own confirmation card. The input goes through
    // the already verified single append with the stable implementation ID.
    owner.removePlanImplementationRequest(id,plan.turnId);
    await submit(owner,{conversationId:id,messageId:request.messageId,text});
    return workflow('set','implementation',request.requestId,{...receipt,status:'applied',settings:settingsView(owner.getConversation(id))});
  } catch {return receipt;}
  finally {hold[Symbol.dispose]();}
}

export async function control(owner, request) {
  const { conversationId: id, operation, messageId, text, order } = request;
  check(owner, id);
  const queue = owner.turnCoordinator;
  await queue.loadMessages(id);
  const server = queue.serverQueue?.isEnabled(id) ? queue.serverQueue : null;
  if (operation === 'inspect' && server) await server.load(id);
  const entryId = messageId == null ? null : queue.readMessages(id)?.find(item =>
    (item.clientUserMessageId ?? item.id) === messageId)?.id ?? messageId;
  if (operation === 'hold') {
    if (!holds.has(id)) holds.set(id, queue.deferAutomaticTurns(id));
  } else if (operation === 'release') {
    const hold = holds.get(id);
    if (hold) { hold[Symbol.dispose](); holds.delete(id); }
    if (server && !owner.isConversationStreaming(id)) await server.resume?.(id);
  } else if (operation === 'native-append') {
    const item = message(owner, id, messageId, text);
    if (server) await server.enqueue(id, item);
    else await queue.restoreQueuedMessage(id, { index: Number.MAX_SAFE_INTEGER, message: item });
  } else if (operation === 'remove') {
    await queue.removeQueuedMessage(id, entryId);
  } else if (operation === 'reorder') {
    const entries = queue.readMessages(id);
    await queue.reorderQueuedMessages(id, order.map(key => entries.find(item => (item.clientUserMessageId ?? item.id) === key)?.id ?? key));
  } else if (operation === 'edit') {
    if (server) await server.enqueue(id, message(owner, id, messageId, text), { messageId: entryId });
    else queue.update(id, entryId, item => ({ ...item, text, context: { ...item.context, prompt: text } }));
    await queue.pendingQueueWrites;
  } else if (operation === 'set-mode') {
    if (!['plan','default'].includes(request.mode)) throw Error('Invalid lab mode');
    const previous = owner.getConversation(id).latestCollaborationMode;
    await owner.updateThreadSettingsForNextTurn(id, {collaborationMode:{mode:request.mode, settings:{...previous?.settings,model:'gpt-6-sol',reasoning_effort:'medium',developer_instructions:null}}});
  } else if ((operation === 'pause-all' || operation === 'unpause-all') && !server) {
    queue.mutate(id, items => items.map(item => {
      if (operation === 'pause-all') return { ...item, pausedReason: 'Mobile lab recovery test' };
      if (item.pausedReason !== 'Mobile lab recovery test') return item;
      const { pausedReason, ...rest } = item;
      return rest;
    }));
    await queue.pendingQueueWrites;
  } else if (!['inspect', 'pause-all', 'unpause-all'].includes(operation)) throw Error('Unknown lab control');
  const state = owner.getConversation(id);
  const nativeTurns = state.turnHistory?.kind === 'canonical' ? Object.values(state.turnHistory.history.entitiesByKey) : state.turns ?? [];
  return { turnSettings:nativeTurns.map(turn => ({id:turn.turnId ?? turn.id,status:turn.status,params:{model:turn.params?.model,reasoningEffort:turn.params?.reasoningEffort,effort:turn.params?.effort,collaborationMode:turn.params?.collaborationMode && {mode:turn.params.collaborationMode.mode,settings:{model:turn.params.collaborationMode.settings?.model,reasoning_effort:turn.params.collaborationMode.settings?.reasoning_effort}}}})),
    messages: queue.readMessages(id)?.map(item => ({ ...item, queueEntryId: item.id, id: item.clientUserMessageId ?? item.id })),
    held: holds.has(id), serverQueueEnabled: !!server,
    activeTurnId: queue.options.submissionHost.getActiveTurnId(id),
    acceptedIds: [...new Set([...(await journal('list', id)).map(entry => entry.messageId),
      ...(request.messageIds ?? [])])]
      .filter(messageId => queue.options.wasMessageAccepted(id, messageId)) };
}
