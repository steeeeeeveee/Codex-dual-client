import {readUsage} from './mobile_usage.mjs';
import {modelCatalog, validateSelection, digestPayload, validId, workflow} from './mobile_settings.mjs';

export async function desktopOperation(api, method, request) {
  if (request.hostId !== 'local') throw Error('Local desktop required');
  if (method === 'mobile-desktop-usage') return readUsage(api.send);
  if (method === 'mobile-desktop-probe') return {protocol:'mobile-compose-v1'};
  if (method === 'mobile-desktop-capabilities') {
    const [projects, models] = await Promise.all([api.projects(), modelCatalog(api.send)]);
    const defaults = async cwd => {
      if (!api.defaults) return {inherit:true};
      try {
        const configured = await api.defaults(cwd);
        const model = configured.model ?? models.find(m=>m.isDefault)?.id ?? null;
        return {inherit:true,model,effort:configured.effort ?? models.find(m=>m.id===model)?.defaultEffort ?? null};
      } catch { return {inherit:true}; }
    };
    const [independent, ...locations] = await Promise.all([defaults(null), ...projects.map(p=>defaults(p.cwd))]);
    return {protocol:'mobile-compose-v1', projects:projects.map(p => ({id:p.id,name:p.name})), models,
      defaults:independent,projectDefaults:Object.fromEntries(projects.map((p,i)=>[p.id,locations[i]])), create:true, settings:true,planMode:true,usage:true,imageInputs:true,imageOutputs:true,videoInputs:true};
  }
  if (!validId(request.requestId)) throw Error('Invalid creation request ID');
  const previous = await workflow('get', 'creation', request.requestId);
  if (method === 'mobile-desktop-creation-status') return previous ?? {status:'not-received'};
  if (method !== 'mobile-desktop-create') throw Error('Unsupported desktop operation');
  const {target, model = null, effort = null, text, messageId,mode='default',attachments=[]} = request;
  if (!validId(messageId) || typeof text !== 'string' || (!text.trim()&&!attachments.length) || new TextEncoder().encode(text).length > 32000 ||
      !target || !['project','projectless'].includes(target.type) ||
      Object.keys(target).some(key => !['type','projectId'].includes(key)) ||
      (target.type === 'projectless' && target.projectId != null)||!['plan','default'].includes(mode)) throw Error('Invalid creation input');
  const images=attachments.length?await globalThis.codexMobileLabJournal({operation:'media-validate',attachments}):[];
  const digest = await digestPayload([target,model,effort,text,messageId,mode,...(images.length?[images]:[])]);
  if (previous) {
    if (previous.digest !== digest) throw Error('Creation ID reused with different content');
    return previous;
  }
  let selectedModel=model,selectedEffort=effort;
  try {
    const projects = await api.projects();
    if (target.type === 'project' && !projects.some(p => p.id === target.projectId)) throw Error('Project unavailable; select again');
    const models=await modelCatalog(api.send);
    validateSelection(models,model,effort,true);
    if(mode==='plan') {
      if(!api.prepareMode)throw Error('Native plan mode unavailable');
      if(model==null){const defaults=await api.defaults(target.type==='project'?projects.find(p=>p.id===target.projectId).cwd:null);
        selectedModel=defaults.model??models.find(m=>m.isDefault)?.id;
        selectedEffort=defaults.effort??models.find(m=>m.id===selectedModel)?.defaultEffort;}
      validateSelection(models,selectedModel,selectedEffort);
    }
  } catch (error) { return {status:'invalid', reason:String(error.message)}; }
  // This claim is atomic in Electron's main process, also across renderer windows.
  const claim = await workflow('claim','creation',request.requestId,{digest,status:'uncertain'});
  if (!claim.claimed) return claim.receipt;
  let prepare;
  const settled = async result => {
    if(result.status!=='created')return;
    const saved=await workflow('get','creation',request.requestId);
    if(saved?.status==='created')return;
    const receipt={digest,status:'created',threadId:result.conversationId,messageId,ready:result.firstTurn?.status !== 'not-started'};
    if(mode==='plan'&&receipt.ready) {
      // Save identity before changing mode. An ambiguous setup never creates a
      // second thread or sends a first input under the wrong mode.
      await workflow('set','creation',request.requestId,{...receipt,status:'uncertain',ready:false});
      prepare??=api.prepareMode(result.conversationId,mode,selectedModel,selectedEffort);
      await prepare;
    }
    await workflow('set','creation',request.requestId,receipt);
  };
  try {
    // Native projectless directories, project rules, permission selection and
    // sidebar registration. First input is subsequently delivered by the shared queue.
    const result = await api.create({target,model:selectedModel ?? undefined,thinking:selectedEffort ?? undefined,prompt:text,
      startWithoutFirstTurn:{},onSettled:settled});
    await settled(result.result);
    if(result.result.status==='failed')await workflow('set','creation',request.requestId,
      {digest,status:'uncertain',reason:String(result.result.message??'Native creation failed').slice(0,300)});
    if (result.result.status === 'created' && result.result.firstTurn?.status === 'not-requested') {
      await api.append(result.result.conversationId,messageId,text,...(images.length?[images]:[]));
    }
  } catch (error) {
    // A thrown/late creation can already have a thread. Keep the durable claim;
    // onSettled may still prove success. Never create another thread for this ID.
    const receipt=await workflow('get','creation',request.requestId);
    if(receipt?.status==='uncertain')await workflow('set','creation',request.requestId,
      {...receipt,reason:typeof error.message==='string'?error.message.slice(0,300):'Native creation could not be confirmed'});
  }
  return await workflow('get','creation',request.requestId);
}
