"""Inspect an installed desktop archive without extracting or executing it."""
import hashlib
import json
from pathlib import Path
import re
import struct


class AsarArchive:
    def __init__(self, path):
        self.path = Path(path)
        with self.path.open('rb') as stream:
            prefix = stream.read(16)
            if len(prefix) != 16:
                raise ValueError('Truncated ASAR header')
            marker, header_size, _, json_size = struct.unpack('<4I', prefix)
            if marker != 4 or not 0 < json_size <= 32 * 1024 * 1024 or json_size > header_size - 8:
                raise ValueError('Invalid ASAR header')
            self.header = json.loads(stream.read(json_size))
        self.base = 8 + header_size
        self.size = self.path.stat().st_size
        self.entries = dict(self._walk(self.header))

    def _walk(self, node, prefix=''):
        for name, value in node.get('files', {}).items():
            path = prefix + name
            if 'files' in value:
                yield from self._walk(value, path + '/')
            else:
                yield path, value

    def read(self, name):
        entry = self.entries[name]
        if entry.get('unpacked') or 'link' in entry:
            raise ValueError('Only packed archive entries may be inspected')
        start, size = self.base + int(entry['offset']), entry['size']
        if start < self.base or not isinstance(size, int) or not 0 <= size <= 64 * 1024 * 1024 or start + size > self.size:
            raise ValueError('Invalid ASAR entry bounds')
        with self.path.open('rb') as stream:
            stream.seek(start)
            data = stream.read(size)
        if len(data) != size:
            raise ValueError('Truncated ASAR entry')
        return data


def inspect_desktop(archive_path):
    archive = AsarArchive(archive_path)
    sources = {}
    for name in archive.entries:
        if name.endswith('.js') and (name.startswith('.vite/build/') or name.startswith('webview/assets/app-shared-')):
            sources[name] = archive.read(name).decode('utf-8')
    native_queue_methods = sorted(set(method for source in sources.values()
        for method in re.findall(r'thread/queue/[a-z]+', source)))
    versions = {}
    for source in sources.values():
        versions.update({name: int(version) for name, version in
                         re.findall(r'"(thread-[a-z-]+)":(\d+)', source)})
    follower_methods = sorted(name for name in versions if name.startswith('thread-follower-'))
    evidence = []
    markers = {
        'replaces_entire_queue': 'acceptFromFollower=async(e,t)=>{await this.#h(e,()=>t,!0)}',
        'replacement_dispatch': 'e.turnCoordinator.acceptFromFollower(t.params.conversationId,t.params.state[t.params.conversationId]??[])',
        'owner_atomic_mutator_is_internal': 'a=t(i),Sw(a);let r={...n};return a.length===0?delete r[e]:r[e]=a,r}',
        'prepared_send_bypasses_queue': 'this.submission.submitPrepared(e,`send-now`,!1)',
    }
    findings = {}
    for key, marker in markers.items():
        matches = [name for name, source in sources.items() if marker in source]
        findings[key] = bool(matches)
        evidence.extend({'finding': key, 'entry': name,
                         'sha256': hashlib.sha256(sources[name].encode()).hexdigest(),
                         'excerpt': marker} for name in matches)
    # Discovering a method name or connecting a reader is not proof of safe
    # submission. There is deliberately no automatically accepted adapter yet.
    return {
        'schemaVersion': 1,
        'installation': str(Path(archive_path).parents[2].name),
        'sourceFingerprint': hashlib.sha256(''.join(
            name + ':' + hashlib.sha256(source.encode()).hexdigest()
            for name, source in sorted(sources.items())).encode()).hexdigest(),
        'capabilities': {
            'ownerDiscoveryDeclared': 'thread-owner-discovery' in versions,
            'stateSubscriptionDeclared': 'thread-stream-state-changed' in versions,
            'queueNotificationsDeclared': 'thread-queued-followups-changed' in versions,
            'singleAppendVerified': False,
            'nativeServerQueueAddDeclared': 'thread/queue/add' in native_queue_methods,
        },
        'sharedSubmissionEnabled': False,
        'gate': 'blocked_unsafe_queue_replacement' if findings['replaces_entire_queue'] else 'unverified_desktop_version',
        'findings': findings,
        'followerMethods': follower_methods,
        'nativeServerQueueMethods': native_queue_methods,
        'protocolVersions': {k: versions[k] for k in sorted(versions) if k in (
            'thread-owner-discovery', 'thread-stream-state-changed',
            'thread-stream-following-changed', 'thread-queued-followups-changed',
            'thread-follower-load-complete-history')},
        'evidence': evidence,
    }
