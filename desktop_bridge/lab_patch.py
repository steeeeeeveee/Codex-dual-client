"""Version-pinned source patch for a disposable desktop lab, not an installer."""
import hashlib
from pathlib import Path
import re

MAIN = '.vite/build/main-DAwJoFgo.js'
MAIN_SHA256 = '18beea7d7e46866168528ff5dab5108ffe6d39fc13433367ce8dee7b187044f8'
RENDERER_SHA256 = 'f2e66afbe63473bd10f6480b47c4c5c9c321144bf36bf9ceaeb75d7242770d5b'
METHOD = 'thread-follower-mobile-lab-append'
CONTROL = 'thread-follower-mobile-lab-control'
STATE = 'thread-follower-mobile-lab-state'
ANSWER = 'thread-follower-mobile-lab-answer'
SETTINGS = 'thread-follower-mobile-lab-settings'
GLOBAL_METHODS = ['mobile-desktop-usage','mobile-desktop-capabilities', 'mobile-desktop-create', 'mobile-desktop-creation-status']
INITIAL = 'webview/assets/app-initial-ff48311587c5.js'
INITIAL_SHA256 = '41d8d711bb87cb6941bcca253b913b521d008d0ef077b1b4b3f75a82113b0579'
PIPE_NAME = 'codex-mobile-isolated-lab'
APPEND_METHOD = '''async mobileAppendSingle(conversationId,message){
 if(this.options.getStreamRole(conversationId)?.role!==`owner`)throw Error(`Desktop owner required`);
 await this.loadMessages(conversationId);
 if(this.serverQueue?.isEnabled(conversationId)){
   if((this.#f(conversationId)??[]).length)throw Error(`Mixed legacy/server queue requires reconciliation`);
   if(!this.serverQueue.canEnqueue(message))throw Error(`Message is not supported by the native server queue`);
   return await this.serverQueue.enqueue(conversationId,message);
 }
 await this.#h(conversationId,latest=>latest.some(item=>item.id===message.id)?latest:[...latest,message],!0);
 return {messageId:message.id};
}'''


def replace_once(text, before, after):
    if text.count(before) != 1:
        raise ValueError('Desktop source changed; refusing patch: ' + before[:60])
    return text.replace(before, after, 1)


def patch_sources(archive, thread_id=None, *, shared=False, all_local=False):
    if thread_id is not None and not re.fullmatch(r'[0-9a-f-]{36}', thread_id):
        raise ValueError('Invalid test conversation ID')
    if '.vite/build/main-BGDKyzfM.js' in archive.entries:
        from .lab_patch_928 import patch_sources_928
        return patch_sources_928(archive, thread_id, shared=shared, all_local=all_local)
    main = archive.read(MAIN)
    if hashlib.sha256(main).hexdigest() != MAIN_SHA256:
        raise ValueError('Unsupported desktop build; installed files are unchanged')
    source = replace_once(main.decode(), 'case`thread-follower-set-queued-follow-ups-state`:',
        f'case`{METHOD}`:case`{CONTROL}`:case`{STATE}`:case`{ANSWER}`:case`{SETTINGS}`:throw Error(`This lab supports the verified renderer owner only`);'
        'case`thread-follower-set-queued-follow-ups-state`:')
    source = 'require("electron").ipcMain.handle("codex-mobile-lab-journal",(event,request)=>require("./mobile-owner-journal.cjs").handle(event,request));\n' + source
    source = replace_once(source,'this.windowAppearances.set(a,r),this.registeredWindowIds.add(a)',
        'e.webContents.__codexMobilePrimary=r===`primary`,this.windowAppearances.set(a,r),this.registeredWindowIds.add(a)')
    patches = {MAIN: source.encode()}
    registry = '.vite/build/src-B5IOaahd.js'
    patches[registry] = replace_once(archive.read(registry).decode(),
        '"thread-follower-set-queued-follow-ups-state":1,',
        ''.join(f'"{method}":1,' for method in [METHOD,CONTROL,STATE,ANSWER,SETTINGS,*GLOBAL_METHODS])+'"thread-follower-set-queued-follow-ups-state":1,').encode()
    router = '.vite/build/src-BSSLXJxP.js'
    router_source = replace_once(archive.read(router).decode(),
        'a(`thread-follower-set-queued-follow-ups-state`)',
        f'a(`{METHOD}`),a(`{CONTROL}`),a(`{STATE}`),a(`{ANSWER}`),a(`{SETTINGS}`),a(`thread-follower-set-queued-follow-ups-state`)')
    router_source = replace_once(router_source,'o=[t.addRequestHandler(`thread-owner-discovery`,',
        'o=['+','.join('t.addRequestHandler(`'+method+'`,async(t,r)=>{if(e!==`local`||(r.hostId??e)!==`local`)return false;try{return (await qk(i,e,{method:`mobile-desktop-probe`,params:{hostId:e}},Rk)).protocol===`mobile-compose-v1`}catch{return false}},({params:t,hostId:n})=>qk(i,n??e,{method:`'+method+'`,params:t},Rk))' for method in GLOBAL_METHODS)+',t.addRequestHandler(`thread-owner-discovery`,')
    patches[router] = router_source.encode()
    network = '.vite/build/application-network-startup-CY4ZWOz-.js'
    patches[network] = replace_once(archive.read(network).decode(),
        'o.join(`\\\\\\\\.\\\\pipe`,`codex-ipc`)',
        f'o.join(`\\\\\\\\.\\\\pipe`,`{PIPE_NAME}`)').encode()
    patches['.vite/build/mobile-owner-journal.cjs'] = Path(__file__).with_name('owner_journal.cjs').read_bytes()
    preload = '.vite/build/preload.js'
    patches[preload] = archive.read(preload) + b'\nrequire("electron").contextBridge.exposeInMainWorld("codexMobileLabJournal",request=>require("electron").ipcRenderer.invoke("codex-mobile-lab-journal",request));\n'
    renderer = 'webview/assets/app-shared-c568b0b98683.js'
    if hashlib.sha256(archive.read(renderer)).hexdigest() != RENDERER_SHA256:
        raise ValueError('Unsupported desktop renderer')
    source = replace_once(archive.read(renderer).decode(), 'acceptFromFollower=async(e,t)=>',
                          APPEND_METHOD + 'acceptFromFollower=async(e,t)=>')
    source = replace_once(source,
        'this.stopServerQueue=e.subscribe(e=>{this.options.onQueueChanged?.(e),this.#o(e)})',
        'this.stopServerQueue=e.subscribe(e=>{this.options.onQueueChanged?.(e),this.#o(e);'
        'if(this.options.getStreamRole(e)?.role===`owner`)this.options.coordination?.broadcast({conversationId:e,messages:this.readMessages(e)??[]}).catch(()=>{})})')
    source = replace_once(source, 'broadcast({conversationId:e,messages:a})',
        'broadcast({conversationId:e,messages:this.serverQueue?.isEnabled(e)?this.serverQueue.read(e)??[]:a})')
    source = replace_once(source, 'case`thread-follower-set-queued-follow-ups-state`:',
        f'case`{METHOD}`:return {{method:t.method,result:await __mobileOwnerHandle(e,t.params)}};'
        f'case`{CONTROL}`:return {{method:t.method,result:await __mobileOwnerControl(e,t.params)}};'
        f'case`{STATE}`:return {{method:t.method,result:await __mobileOwnerSnapshot(e,t.params)}};'
        f'case`{ANSWER}`:return {{method:t.method,result:await __mobileOwnerAnswer(e,t.params)}};'
        f'case`{SETTINGS}`:return {{method:t.method,result:await __mobileOwnerSettings(e,t.params)}};'
        'case`thread-follower-set-queued-follow-ups-state`:')
    source = replace_once(source,'return n.getManagerForHost(n.scope,e).handleThreadFollowerRequest(t)',
        'if(t.method.startsWith(`mobile-desktop-`)){if(e!==`local`||typeof globalThis.__codexMobileDesktop!==`function`)throw Error(`Desktop creation unavailable`);return {method:t.method,result:await globalThis.__codexMobileDesktop(n.scope,t.method,t.params,n.getManagerForHost(n.scope,e))}}return n.getManagerForHost(n.scope,e).handleThreadFollowerRequest(t)')
    # Versions advance for native desktop edits as well, inside the same store
    # operation. Check the mobile version INSIDE the native settings serial lane.
    source = replace_once(source,'function BB(e,t){let n=', 'function BB(e,t){e.mobileSettingsEpoch=__mobileSettingsEpoch;e.mobileSettingsRevision=(e.mobileSettingsRevision??0)+1;let n=')
    source = replace_once(source,'if(r!=null&&(s?.latestReasoningEffort!==r.ifEffortEquals||',
        'if(r!=null&&(r.mobilePlanRequestId!=null&&(__mobilePlanRequest(s)?.id!==r.mobilePlanRequestId||this.turnCoordinator.options.submissionHost.getActiveTurnId(e)||this.turnCoordinator.readMessages(e)?.length)||r.mobileSettingsVersion!=null&&r.mobileSettingsVersion!==__mobileSettingsVersion(s)||s?.latestReasoningEffort!==r.ifEffortEquals||')
    source = replace_once(source,'return(this.threadSettingsUpdateSupport===`unsupported`||',
        'if(r?.mobileSettingsVersion!=null&&this.threadSettingsUpdateSupport===`unsupported`)throw Error(`Native settings capability unavailable`);return(this.threadSettingsUpdateSupport===`unsupported`||')
    source = replace_once(source,'function f6t(e,t){KV(e.getConversation(Z(t.request.threadId)));',
        'function f6t(e,t){KV(e.getConversation(Z(t.request.threadId)));__mobileAssertQuestion(e.getConversation(Z(t.request.threadId)),t.request.input,t.clientUserMessageId,t.request.expectedTurnId);')
    # A copied desktop has the native dynamic-tool handler but may not have the
    # separate desktop-tools MCP host. Do not create an invalid enabled_tools-
    # only transport. Use the original native dynamic-tools fallback in that case.
    source = replace_once(source,
        'o.dynamicTools=void 0,e.registerDynamicTools!==!1&&(o.dynamicTools=e.usesDesktopMcp?[]:Jut(n)),e.usesDesktopMcp&&(o.config=',
        'o.dynamicTools=void 0;const __mobileUseDesktopMcp=e.usesDesktopMcp&&await globalThis.codexMobileLabJournal({operation:`desktop-tools-ready`});e.registerDynamicTools!==!1&&(o.dynamicTools=__mobileUseDesktopMcp?[]:Jut(n)),__mobileUseDesktopMcp&&(o.config=')
    source = 'import {planRequest as __mobilePlanRequest,assertAsyncAnswerCurrent as __mobileAssertQuestion} from "./plan_workflow.mjs";\nimport {settingsVersion as __mobileSettingsVersion,settingsEpoch as __mobileSettingsEpoch} from "./mobile_settings.mjs";\nimport {handle as __mobileOwnerHandle,control as __mobileOwnerControl,snapshot as __mobileOwnerSnapshot,answer as __mobileOwnerAnswer,settings as __mobileOwnerSettings} from "./mobile-owner-renderer.js";\n' + source
    patches[renderer] = source.encode()
    initial = archive.read(INITIAL)
    if hashlib.sha256(initial).hexdigest() != INITIAL_SHA256:
        raise ValueError('Unsupported desktop creation bundle')
    facade = '''
globalThis.__codexMobileDesktop=async(scope,method,request,manager)=>{
 if(!await globalThis.codexMobileLabJournal({operation:`workflow-ready`}))throw Error(`Primary desktop window required`);
 roo();
 const api={
   send:(method,params)=>rm(scope,`local`).sendRequest(method,params),
   projects:async()=>{const {value}=await yf(`get-global-state`,{params:{key:Zp.LOCAL_PROJECTS}});return Object.entries(ooe(value)).map(([id,p])=>({id,name:p.name??p.title??id,cwd:p.rootPaths?.[0]??null}));},
   defaults:async cwd=>{const {config}=await qOn(scope,`local`,{includeLayers:false,cwd});const value=mi(config);return {model:value.model??null,effort:value.model_reasoning_effort??null};},
   create:params=>Uao({scope,...params,threadSource:`user`,turnTrigger:`app_tool_create_thread`}),
   prepareMode:async(conversationId,mode,model,effort)=>{manager.assertThreadFollowerOwner(conversationId);const applied=await manager.updateThreadSettingsForNextTurn(conversationId,{collaborationMode:{mode,settings:{model,reasoning_effort:effort,developer_instructions:null}}});if(!applied)throw Error(`Mode not applied`);},
   append:async(conversationId,messageId,text,attachments)=>{const owner=rm(scope,`local`);if(owner.getConversation(conversationId)?.resumeState!==`resumed`){const ready=await owner.resumeConversation({conversationId,model:null,reasoningEffort:null,serviceTier:null,workspaceRoots:[owner.getConversationCwd(conversationId)??`/`],collaborationMode:null,showThreadGoalResumeConfirmation:false},{readResumeInputs:Um(scope,`local`)});if(ready.status!==`ready`)throw Error(`Created desktop conversation not ready`);}return owner.handleThreadFollowerRequest({method:`thread-follower-mobile-lab-append`,params:{conversationId,messageId,text,...(attachments?{attachments}:{})}});}
 };
 return __mobileDesktopOperation(api,method,request);
};
'''
    patches[INITIAL] = ('import {desktopOperation as __mobileDesktopOperation} from "./desktop_creation.mjs";\n'+initial.decode()+facade).encode()
    for module in ['mobile_settings.mjs','desktop_creation.mjs','mobile_usage.mjs','plan_workflow.mjs','turn_control.mjs']:
        patches['webview/assets/'+module] = Path(__file__).with_name(module).read_bytes()
    patches['webview/assets/mobile-owner-renderer.js'] = Path(__file__).with_name('owner_renderer.mjs').read_text(encoding='utf-8').replace(
        '__CODEX_MOBILE_TEST_THREAD__', '*' if shared or all_local else thread_id or '').encode()
    return shared_patches(patches, MAIN) if shared else patches


def shared_patches(patches, main_name):
    # The deployed build has no test mutation endpoint. Keep the original
    # installation and its IPC namespace separate for reversible rollout.
    for name, data in list(patches.items()):
        text = data.decode()
        text = text.replace(f'case`{CONTROL}`:', '') if name == main_name else text
        text = text.replace(f'"{CONTROL}":1,', '').replace(f'a(`{CONTROL}`),', '')
        text = text.replace(f'case`{CONTROL}`:return {{method:t.method,result:await __mobileOwnerControl(e,t.params)}};', '')
        text = text.replace('control as __mobileOwnerControl,', '')
        for before, after in [(METHOD,'thread-follower-mobile-append'),(STATE,'thread-follower-mobile-state'),(ANSWER,'thread-follower-mobile-answer'),(SETTINGS,'thread-follower-mobile-settings'),(PIPE_NAME,'codex-mobile-shared-desktop')]:
            text = text.replace(before,after)
        if name == 'webview/assets/mobile-owner-renderer.js':
            text = text[:text.index('\nexport async function control(')]
        text = text.replace('await this.#h(conversationId,latest=>latest.some(item=>item.id===message.id)?latest:[...latest,message],!0);\n return {messageId:message.id};', 'throw Error(`Native queue capability unavailable`);')
        patches[name] = text.encode()
    return patches
