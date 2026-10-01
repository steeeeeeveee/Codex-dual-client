"""Build an isolated, unsigned lab copy; no production installation writes."""
import copy
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from desktop_bridge.inspection import AsarArchive
from desktop_bridge.lab_patch import patch_sources, PIPE_NAME


def rebuild_archive(source, target, patches):
    archive = AsarArchive(source)
    header = copy.deepcopy(archive.header)
    payload = target.with_suffix('.payload')
    with payload.open('wb') as output:
        offset = 0
        entries = dict(archive._walk(header))
        for name in patches:
            if name not in entries:
                node = header
                parts = name.split('/')
                for component in parts[:-1]:
                    node = node['files'][component]
                node['files'][parts[-1]] = {}
        for name, entry in archive._walk(header):
            if entry.get('unpacked') or 'link' in entry:
                continue
            data = patches[name] if name in patches else archive.read(name)
            entry.update(size=len(data), offset=str(offset))
            if name in patches:
                block_size = 4 * 1024 * 1024
                entry['integrity'] = {'algorithm': 'SHA256', 'hash': hashlib.sha256(data).hexdigest(),
                    'blockSize': block_size, 'blocks': [hashlib.sha256(data[i:i + block_size]).hexdigest()
                        for i in range(0, len(data), block_size)]}
            output.write(data)
            offset += len(data)
    rendered = json.dumps(header, separators=(',', ':'), ensure_ascii=False).encode()
    padded = (len(rendered) + 3) & ~3
    pickle_data = struct.pack('<II', padded + 4, len(rendered)) + rendered + bytes(padded - len(rendered))
    with target.open('wb') as output, payload.open('rb') as stream:
        output.write(struct.pack('<II', 4, len(pickle_data)) + pickle_data)
        shutil.copyfileobj(stream, output)
    payload.unlink()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--refresh', type=Path, help='Refresh a stopped lab after seeding its test conversation')
    args = parser.parse_args()
    if args.refresh:
        manifest_path = args.refresh.resolve()
        manifest = json.loads(manifest_path.read_text())
        base = Path(manifest['base']).resolve()
        if manifest_path.parent != base or base.parent != (ROOT / 'runtime/desktop-prototype').resolve():
            raise ValueError('Expected a lab manifest inside this workspace')
        if not (base / 'stop-lab').exists():
            raise ValueError('Stop the lab before refreshing it')
        source = Path(manifest['sourceInstallation']) / 'app'
        archive = source / 'resources/app.asar'
        patches = patch_sources(AsarArchive(archive), manifest['threadId'], all_local=manifest.get('allLocal',False))
        destination = base / 'app'
        rebuilt = destination / 'resources/app.asar'
        rebuild_archive(archive, rebuilt, patches)
        spec = importlib.util.spec_from_file_location('loader_probe', ROOT / 'scripts/probe-desktop-loader.py')
        loader = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(loader)
        manifest['archiveDigest'] = loader.bind_test_archive(destination / 'ChatGPT.exe', rebuilt)
        manifest_path.write_text(json.dumps(manifest, indent=2), encoding='utf-8')
        (base / 'stop-lab').unlink()
        print('Refreshed isolated lab; production installation unchanged')
        return
    location = subprocess.check_output(['powershell', '-NoProfile', '-Command',
        '(Get-AppxPackage OpenAI.Codex | Select-Object -First 1).InstallLocation'], text=True).strip()
    source = Path(location) / 'app'
    archive = source / 'resources/app.asar'
    patches = patch_sources(AsarArchive(archive))  # Check pinned source BEFORE any copy.
    base = ROOT / 'runtime/desktop-prototype' / ('full-' + uuid.uuid4().hex[:12])
    destination = base / 'app'
    print('Copying disposable desktop runtime...', flush=True)
    shutil.copytree(source, destination, ignore=shutil.ignore_patterns('app.asar'))
    print('Building version-pinned lab archive...', flush=True)
    rebuilt = destination / 'resources/app.asar'
    rebuild_archive(archive, rebuilt, patches)
    spec = importlib.util.spec_from_file_location('loader_probe', ROOT / 'scripts/probe-desktop-loader.py')
    loader = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loader)
    digest = loader.bind_test_archive(destination / 'ChatGPT.exe', rebuilt)
    manifest = {'base': str(base), 'executable': str(destination / 'ChatGPT.exe'),
        'sourceInstallation': location, 'archiveDigest': digest,
        'pipe': '\\\\.\\pipe\\' + PIPE_NAME, 'sharedSubmissionEnabled': False,
        'profile': str(base / 'profile'), 'codexHome': str(base / 'codex-home'),
        'workspace': str(base / 'workspace'), 'signature': 'modified-local-copy'}
    for key in ['profile', 'codexHome', 'workspace']:
        Path(manifest[key]).mkdir()
    (base / 'manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    print(json.dumps(manifest, indent=2))


if __name__ == '__main__':
    main()
