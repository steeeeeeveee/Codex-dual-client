// Observer-only projection of the desktop's versioned Immer stream. Never write
// conversation state back. Only public chat text crosses the stdio boundary.
import {settingsView} from './mobile_settings.mjs';
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const own = (object, key) => Object.hasOwn(object, key);

export function applyPatch(state, patch) {
  const {op, path, value} = patch;
  if (!['add', 'replace', 'remove'].includes(op) || !Array.isArray(path) ||
      path.some(key => forbidden.has(String(key)))) throw Error('Unsupported stream patch');
  if (!path.length) {
    if (op !== 'replace') throw Error('Invalid root patch');
    return structuredClone(value);
  }
  let parent = state;
  for (const key of path.slice(0, -1)) {
    if (!parent || typeof parent !== 'object' || !own(parent, key)) throw Error('Missing stream path');
    parent = parent[key];
  }
  const key = path.at(-1);
  if (!parent || typeof parent !== 'object') throw Error('Invalid stream path');
  if (Array.isArray(parent)) {
    if (key === 'length' && op === 'replace' && Number.isSafeInteger(value) && value >= 0 && value <= parent.length) {
      parent.length = value;
    } else {
      if (!Number.isSafeInteger(key) || key < 0 || key > parent.length || (op !== 'add' && key === parent.length)) throw Error('Invalid stream index');
      if (op === 'add') parent.splice(key, 0, structuredClone(value));
      else if (op === 'remove') parent.splice(key, 1);
      else parent[key] = structuredClone(value);
    }
  } else {
    if (op !== 'add' && !own(parent, key)) throw Error('Missing stream value');
    if (op === 'remove') delete parent[key];
    else parent[key] = structuredClone(value);
  }
  return state;
}

export function projectTranscript(state,projectMedia=(_original,value)=>value) {
  let turns = state.turns;
  if (state.turnHistory?.kind === 'canonical') {
    const history = state.turnHistory.history;
    const keys = [...new Set(history.islands.flatMap(island => island.entries.map(entry => entry.value)))];
    turns = keys.map(key => history.entitiesByKey[key]).filter(Boolean);
  }
  if (!Array.isArray(turns)) throw Error('Unsupported desktop transcript');
  return {
    ...(state.mobileSettingsEpoch ? {settings:settingsView(state)} : {}),
    nickname: typeof state.agentNickname === 'string' && state.agentNickname.trim() ? state.agentNickname.slice(0, 100) : 'Codex',
    turns: turns.filter(turn => typeof (turn.turnId ?? turn.id) === 'string').slice(-20).map(turn => ({
      id: turn.turnId ?? turn.id,
      status: turn.status,
      // Questions/approvals retain their existing, separately validated channel.
      items: (turn.items || []).flatMap(item => {
        if (['agentMessage','plan'].includes(item.type) && typeof item.text === 'string') return [{id:item.id, type:item.type, text:item.text}];
        if (item.type === 'userMessage') return [{id:item.id, type:item.type, content:(item.content || [])
          .filter(part => part.type === 'text' && typeof part.text === 'string'||part.type==='localImage'&&typeof part.path==='string'||part.type==='image'&&typeof part.url==='string')
          .map(part => part.type==='text'?{type:'text',text:part.text}:projectMedia(part,part.type==='localImage'?{type:'localImage',path:part.path}:{type:'image',url:part.url}))}];
        if(item.type==='imageGeneration')return [projectMedia(item,{id:item.id,type:item.type,status:item.status,savedPath:item.savedPath,src:item.src,result:item.result})];
        return [];
      }),
    })),
  };
}

export class TranscriptStream {
  constructor(threadId, owner, {projectMedia}={}) { this.threadId = threadId; this.owner = owner; this.projectMedia=projectMedia; }
  revision = -1;
  state = null;
  accept(message) {
    if (message.method !== 'thread-stream-state-changed' || message.sourceClientId !== this.owner ||
        message.params?.hostId !== 'local' || message.params.conversationId !== this.threadId) return null;
    const change = message.params.change;
    if (!Number.isSafeInteger(change?.revision)) throw Error('Invalid stream revision');
    if (change.revision <= this.revision) return null; // Duplicate or late frame.
    if (change.type === 'snapshot') {
      if (change.conversationState?.id !== this.threadId) throw Error('Stream thread mismatch');
      this.state = structuredClone(change.conversationState);
    } else if (change.type === 'patches' && this.state && change.baseRevision === this.revision) {
      for (const patch of change.patches) this.state = applyPatch(this.state, patch);
    } else throw Error('Stream revision gap');
    this.revision = change.revision;
    // acceptedTextChanges is a desktop transcript-cache optimization; the same
    // text is already present in the authoritative patches. Do not append twice.
    return {...projectTranscript(this.state,this.projectMedia), revision:this.revision};
  }
}
