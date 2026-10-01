import { ReadOnlyDesktopClient } from './read_only_client.mjs';

const conversationId = process.argv[2];
if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(conversationId || '')) throw new Error('An existing thread ID is required');
const client = new ReadOnlyDesktopClient();
const report = { connected: false, ownerFound: false, snapshotReceived: false,
  queueNotificationReceived: false, conversationId, mutationsSent: 0, sharedSubmissionEnabled: false };
try {
  await client.connect(); report.connected = true;
  const owner = await client.findOwner(conversationId);
  report.ownerFound = owner != null;
  if (owner) {
    let snapshotReady;
    const ready = new Promise(resolve => { snapshotReady = resolve; });
    client.onBroadcast = message => {
      if (message.sourceClientId !== owner || message.params?.conversationId !== conversationId || message.params?.hostId !== 'local') return;
      if (message.method === 'thread-queued-followups-changed' && message.version === 2) {
        report.queueNotificationReceived = true;
        report.queuedCount = Array.isArray(message.params.messages) ? message.params.messages.length : null;
      }
      if (message.method !== 'thread-stream-state-changed' || message.version !== 11) return;
      const change = message.params.change;
      if (change?.type !== 'snapshot' || !change.conversationState) return;
      report.snapshotReceived = true;
      report.stateRevision = change.revision;
      const state = change.conversationState;
      // Only retain shape/counts, never message text, tools, paths or secrets.
      report.stateKeys = Object.keys(state).sort();
      report.pendingRequestCount = Array.isArray(state.requests) ? state.requests.length : null;
      report.visibleTurnCount = Array.isArray(state.turns) ? state.turns.length : null;
      snapshotReady();
    };
    client.follow(conversationId, owner);
    let timer;
    await Promise.race([ready, new Promise(resolve => { timer = setTimeout(resolve, 8000); })]);
    clearTimeout(timer);
  }
} catch (error) {
  report.error = error.code || error.message;
  process.exitCode = 1;
} finally {
  client.close();
  console.log(JSON.stringify(report, null, 2));
}
