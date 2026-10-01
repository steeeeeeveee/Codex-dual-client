// Public settings only. Permission and developer-instruction fields never leave the owner.
export const settingsEpoch = globalThis.crypto.randomUUID();
export function settingsVersion(state) {
  return `${state?.mobileSettingsEpoch ?? settingsEpoch}:${state?.mobileSettingsRevision ?? 0}:${JSON.stringify([state?.latestModel, state?.latestReasoningEffort,state?.latestCollaborationMode?.mode ?? 'default'])}`;
}
export function settingsView(state, activeTurnId = null) {
  let turns = state?.turns ?? [];
  if (state?.turnHistory?.kind === 'canonical') turns = Object.values(state.turnHistory.history.entitiesByKey);
  const active = turns.find(turn => activeTurnId ? (turn.turnId ?? turn.id) === activeTurnId : turn.status === 'inProgress');
  const params = active?.params;
  const current = params ? {model:params.collaborationMode?.settings?.model ?? params.model ?? null,
    effort:params.collaborationMode?.settings?.reasoning_effort ?? params.reasoningEffort ?? params.effort ?? null,
    mode:params.collaborationMode?.mode ?? 'default',
    turnId:active.turnId ?? active.id} : null;
  return {version:settingsVersion(state), next:{model:state?.latestModel ?? null, effort:state?.latestReasoningEffort ?? null,mode:state?.latestCollaborationMode?.mode ?? 'default'}, current};
}
export async function modelCatalog(send) {
  const models = []; let cursor = null;
  do {
    const page = await send('model/list', {includeHidden:false, limit:100, cursor});
    for (const item of page.data ?? []) {
      if (item.hidden || !item.model || !Array.isArray(item.supportedReasoningEfforts)) continue;
      models.push({id:item.model, name:item.displayName || item.model, isDefault:!!item.isDefault,
        defaultEffort:item.defaultReasoningEffort,
        efforts:item.supportedReasoningEfforts.map(e => ({id:e.reasoningEffort, description:e.description || ''}))});
    }
    if (page.nextCursor && page.nextCursor === cursor) throw Error('Invalid model catalog cursor');
    cursor = page.nextCursor;
  } while (cursor);
  return models;
}
export function validateSelection(models, model, effort, inherit = false) {
  if (inherit && model == null && effort == null) return;
  const entry = models.find(item => item.id === model);
  if (!entry || !entry.efforts.some(item => item.id === effort)) throw Error('Model or reasoning effort unavailable; select again');
}
export async function digestPayload(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}
export const validId = id => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);
export const workflow = (operation, kind, requestId, receipt) => globalThis.codexMobileLabJournal({operation:`workflow-${operation}`,kind,requestId,receipt});
