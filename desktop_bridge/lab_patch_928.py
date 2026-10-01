"""Pinned adapter for desktop 26.928.1915.0; preserve the older adapter for rollback."""
import hashlib
from pathlib import Path
from .lab_patch import (METHOD, CONTROL, STATE, ANSWER, SETTINGS, GLOBAL_METHODS,
                       PIPE_NAME, replace_once, shared_patches)

PINNED = {
    '.vite/build/main-BGDKyzfM.js': 'a44bacb4f1627c74d9d087695074d5abfe3d8a896aa38debca368bbe0cb37a8b',
    '.vite/build/bootstrap-Bj_1Kfw1.js': '3e36ecd7908d2b39dfbd57e223fe798c159ea7fda67c9fbe3e4822fae1b9be98',
    '.vite/build/src-ghAWefM3.js': '4ff55fed651b74a13b6cc7f65a47c6f662ffe5475b903cb902cffd545ad1252e',
    '.vite/build/application-network-startup-D74LEWDz.js': '9d0317f090ce2b9bc8edb9604a2adc66c8839278fa9d1037dcbf51a5e673bb95',
    'webview/assets/app-shared-6472dfc83b38.js': 'f17abe823ba920bf3e34dc41a88d0327d27dc3ae6ac80209c87984f0d525523d',
    'webview/assets/app-initial-7e7a15e7e995.js': '7d08ce3aa67263d7148250292a268b5216a7701b6e4ebc7ec664495b6e128405',
}
MAIN, BOOTSTRAP, REGISTRY, NETWORK, RENDERER, INITIAL = PINNED

APPEND = '''async mobileAppendSingle(conversationId,message){
 if(this.options.getStreamRole(conversationId)?.role!==`owner`)throw Error(`Desktop owner required`);
 await this.loadMessages(conversationId);
 if(!this.serverQueue?.isEnabled(conversationId))throw Error(`Native queue capability unavailable`);
 if((this.#p(conversationId)??[]).length)throw Error(`Mixed legacy/server queue requires reconciliation`);
 if(!this.serverQueue.canEnqueue(message))throw Error(`Message is not supported by the native server queue`);
 return await this.serverQueue.enqueue(conversationId,message);
}'''


def patch_sources_928(archive, thread_id=None, *, shared=False, all_local=False):
    sources = {}
    for name, digest in PINNED.items():
        value = archive.read(name)
        if hashlib.sha256(value).hexdigest() != digest:
            raise ValueError('Unsupported desktop build; installed files are unchanged: ' + name)
        sources[name] = value.decode()
    patches = {}
    main = replace_once(sources[MAIN], 'this.windowAppearances.set(a,r),this.registeredWindowIds.add(a)',
        'e.webContents.__codexMobilePrimary=r===`primary`,this.windowAppearances.set(a,r),this.registeredWindowIds.add(a)')
    patches[MAIN] = ('require("electron").ipcMain.handle("codex-mobile-lab-journal",(event,request)=>require("./mobile-owner-journal.cjs").handle(event,request));\n' + main).encode()
    methods = [METHOD, CONTROL, STATE, ANSWER, SETTINGS]
    router = replace_once(sources[BOOTSTRAP], 'case`thread-follower-set-queued-follow-ups-state`:',
        ''.join(f'case`{m}`:' for m in methods) + 'throw Error(`This lab supports the verified renderer owner only`);case`thread-follower-set-queued-follow-ups-state`:')
    router = replace_once(router, 'a(`thread-follower-set-queued-follow-ups-state`)',
        ','.join(f'a(`{m}`)' for m in methods) + ',a(`thread-follower-set-queued-follow-ups-state`)')
    router = replace_once(router, 'o=[t.addRequestHandler(`thread-owner-discovery`,',
        'o=[' + ','.join('t.addRequestHandler(`'+method+'`,async(t,r)=>{if(e!==`local`||(r.hostId??e)!==`local`)return false;try{return (await yq(i,e,{method:`mobile-desktop-probe`,params:{hostId:e}},uq)).protocol===`mobile-compose-v1`}catch{return false}},({params:t,hostId:n})=>yq(i,n??e,{method:`'+method+'`,params:t},uq))' for method in GLOBAL_METHODS) + ',t.addRequestHandler(`thread-owner-discovery`,')
    patches[BOOTSTRAP] = router.encode()
    patches[REGISTRY] = replace_once(sources[REGISTRY], '"thread-follower-set-queued-follow-ups-state":1,',
        ''.join(f'"{m}":1,' for m in [*methods, *GLOBAL_METHODS]) + '"thread-follower-set-queued-follow-ups-state":1,').encode()
    patches[NETWORK] = replace_once(sources[NETWORK], 'c.join(`\\\\\\\\.\\\\pipe`,`codex-ipc`)',
        f'c.join(`\\\\\\\\.\\\\pipe`,`{PIPE_NAME}`)').encode()
    patches['.vite/build/mobile-owner-journal.cjs'] = Path(__file__).with_name('owner_journal.cjs').read_bytes()
    patches['.vite/build/preload.js'] = archive.read('.vite/build/preload.js') + b'\nrequire("electron").contextBridge.exposeInMainWorld("codexMobileLabJournal",request=>require("electron").ipcRenderer.invoke("codex-mobile-lab-journal",request));\n'
    source = replace_once(sources[RENDERER], 'acceptFromFollower=async(e,t,n=[])=>', APPEND + 'acceptFromFollower=async(e,t,n=[])=>')
    source = replace_once(source, 'this.stopServerQueue=e.subscribe(e=>{this.options.onQueueChanged?.(e),this.#o(e)})',
        'this.stopServerQueue=e.subscribe(e=>{this.options.onQueueChanged?.(e),this.#o(e);if(this.options.getStreamRole(e)?.role===`owner`)this.options.coordination?.broadcast({conversationId:e,messages:this.readMessages(e)??[]}).catch(()=>{})})')
    source = replace_once(source, 'broadcast({conversationId:e,messages:o})',
        'broadcast({conversationId:e,messages:this.serverQueue?.isEnabled(e)?this.serverQueue.read(e)??[]:o})')
    source = replace_once(source, 'case`thread-follower-set-queued-follow-ups-state`:',
        ''.join(f'case`{method}`:return {{method:t.method,result:await {handler}(e,t.params)}};'
                for method, handler in [(METHOD,'__mobileOwnerHandle'),(CONTROL,'__mobileOwnerControl'),(STATE,'__mobileOwnerSnapshot'),(ANSWER,'__mobileOwnerAnswer'),(SETTINGS,'__mobileOwnerSettings')]) + 'case`thread-follower-set-queued-follow-ups-state`:')
    source = replace_once(source, 'return n.getManagerForHost(n.scope,e).handleThreadFollowerRequest(t)',
        'if(t.method.startsWith(`mobile-desktop-`)){if(e!==`local`||typeof globalThis.__codexMobileDesktop!==`function`)throw Error(`Desktop creation unavailable`);return {method:t.method,result:await globalThis.__codexMobileDesktop(n.scope,t.method,t.params,n.getManagerForHost(n.scope,e))}}return n.getManagerForHost(n.scope,e).handleThreadFollowerRequest(t)')
    source = replace_once(source, 'function xB(e,t){let n=',
        'function xB(e,t){e.mobileSettingsEpoch=__mobileSettingsEpoch;e.mobileSettingsRevision=(e.mobileSettingsRevision??0)+1;let n=')
    source = replace_once(source, 'if(r!=null&&(s?.latestReasoningEffort!==r.ifEffortEquals||',
        'if(r!=null&&(r.mobilePlanRequestId!=null&&(__mobilePlanRequest(s)?.id!==r.mobilePlanRequestId||this.turnCoordinator.options.submissionHost.getActiveTurnId(e)||this.turnCoordinator.readMessages(e)?.length)||r.mobileSettingsVersion!=null&&r.mobileSettingsVersion!==__mobileSettingsVersion(s)||s?.latestReasoningEffort!==r.ifEffortEquals||')
    source = replace_once(source, 'return(this.threadSettingsUpdateSupport===`unsupported`||',
        'if(r?.mobileSettingsVersion!=null&&this.threadSettingsUpdateSupport===`unsupported`)throw Error(`Native settings capability unavailable`);return(this.threadSettingsUpdateSupport===`unsupported`||')
    source = replace_once(source, 'function von(e,t){Hz(e.getConversation(Z(t.request.threadId)));',
        'function von(e,t){Hz(e.getConversation(Z(t.request.threadId)));__mobileAssertQuestion(e.getConversation(Z(t.request.threadId)),t.request.input,t.clientUserMessageId,t.request.expectedTurnId);')
    # This standalone copy lacks the Store Core's MCP configuration handshake.
    # Its new pipe can exist but enabling codex_app then fails thread/start.
    # Keep the native dynamic-tools path (same tool definitions and dispatcher),
    # as in older copies without an MCP pipe. Never emit the incomplete override.
    source = replace_once(source, 'o.dynamicTools=void 0,e.registerDynamicTools!==!1&&(o.dynamicTools=e.usesDesktopMcp?[]:pCt(n)),e.usesDesktopMcp&&(o.config=',
        'o.dynamicTools=void 0;const __mobileUseDesktopMcp=false;e.registerDynamicTools!==!1&&(o.dynamicTools=__mobileUseDesktopMcp?[]:pCt(n)),__mobileUseDesktopMcp&&(o.config=')
    imports = ('import {planRequest as __mobilePlanRequest,assertAsyncAnswerCurrent as __mobileAssertQuestion} from "./plan_workflow.mjs";\n'
        'import {settingsVersion as __mobileSettingsVersion,settingsEpoch as __mobileSettingsEpoch} from "./mobile_settings.mjs";\n'
        'import {handle as __mobileOwnerHandle,control as __mobileOwnerControl,snapshot as __mobileOwnerSnapshot,answer as __mobileOwnerAnswer,settings as __mobileOwnerSettings} from "./mobile-owner-renderer.js";\n')
    patches[RENDERER] = (imports + source).encode()
    # Empty native creation now requires an explicit title before onSettled.
    # The first input is still sent only once, through the stable shared queue.
    facade = '''
globalThis.__codexMobileDesktop=async(scope,method,request,manager)=>{
 if(!await globalThis.codexMobileLabJournal({operation:`workflow-ready`}))throw Error(`Primary desktop window required`);
 pVs();
 const api={
   send:(method,params)=>cp(scope,`local`).sendRequest(method,params),
   projects:async()=>{const {value}=await xa(`get-global-state`,{params:{key:Wg.LOCAL_PROJECTS}});return Object.entries(vUe(value)).map(([id,p])=>({id,name:p.name??p.title??id,cwd:p.rootPaths?.[0]??null}));},
   defaults:async cwd=>{const value=await s1r(cp(scope,`local`),cwd);return {model:value.model??null,effort:value.model_reasoning_effort??null};},
   create:params=>rVs({scope,...params,startWithoutFirstTurn:{title:[...params.prompt.trim()].slice(0,80).join(``)||`新对话`},threadSource:`user`,turnTrigger:`app_tool_create_thread`}),
   prepareMode:async(conversationId,mode,model,effort)=>{manager.assertThreadFollowerOwner(conversationId);const applied=await manager.updateThreadSettingsForNextTurn(conversationId,{collaborationMode:{mode,settings:{model,reasoning_effort:effort,developer_instructions:null}}});if(!applied)throw Error(`Mode not applied`);},
   append:async(conversationId,messageId,text,attachments)=>{const owner=cp(scope,`local`);if(owner.getConversation(conversationId)?.resumeState!==`resumed`){const ready=await owner.resumeConversation({conversationId,model:null,reasoningEffort:null,serviceTier:null,workspaceRoots:[owner.getConversationCwd(conversationId)??`/`],collaborationMode:null,showThreadGoalResumeConfirmation:false},{readResumeInputs:ts(scope,`local`)});if(ready.status!==`ready`)throw Error(`Created desktop conversation not ready`);}return owner.handleThreadFollowerRequest({method:`thread-follower-mobile-lab-append`,params:{conversationId,messageId,text,...(attachments?{attachments}:{})}});}
 };
 return __mobileDesktopOperation(api,method,request);
};
'''
    patches[INITIAL] = ('import {desktopOperation as __mobileDesktopOperation} from "./desktop_creation.mjs";\n' + sources[INITIAL] + facade).encode()
    for module in ['mobile_settings.mjs','desktop_creation.mjs','mobile_usage.mjs','plan_workflow.mjs','turn_control.mjs']:
        patches['webview/assets/'+module] = Path(__file__).with_name(module).read_bytes()
    owner = Path(__file__).with_name('owner_renderer.mjs').read_text(encoding='utf-8').replace(
        '__CODEX_MOBILE_TEST_THREAD__', '*' if shared or all_local else thread_id or '')
    # 0.159 uses this error for a new paginated thread before its first rollout.
    # The existing native empty-history guard still rejects every nonempty chat.
    owner = replace_once(owner, '/is not materialized yet|rollout at .* is empty$/',
        '/is not materialized yet|rollout at .* is empty$|invalid paginated history lineage for [0-9a-f-]{36}: missing source rollout$/')
    patches['webview/assets/mobile-owner-renderer.js'] = owner.encode()
    return shared_patches(patches, BOOTSTRAP) if shared else patches
