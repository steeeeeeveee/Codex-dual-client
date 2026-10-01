"""Bounded loading experiment; never modifies the installed desktop package.

The copied runtime gets a tiny app which only writes a marker and exits. No
official app code, account, conversation or IPC client is loaded by this app.
"""
import ctypes
import hashlib
import json
import mmap
import os
from pathlib import Path
import re
import shutil
import stat
import struct
import subprocess
import sys
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from windows_job import contain_process_tree

FUSE_SENTINEL = b'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'
FUSE_NAMES = ['runAsNode', 'cookieEncryption', 'nodeOptions', 'nodeCliInspect',
              'embeddedAsarIntegrity', 'onlyLoadAppFromAsar']


def read_fuses(path):
    with path.open('rb') as stream, mmap.mmap(stream.fileno(), 0, access=mmap.ACCESS_READ) as data:
        offset = data.find(FUSE_SENTINEL)
        if offset < 0:
            raise ValueError('Runtime fuse table not found')
        offset += len(FUSE_SENTINEL)
        version, count = data[offset:offset + 2]
        if version != 1 or count > 32:
            raise ValueError('Unknown runtime fuse format')
        values = data[offset + 2:offset + 2 + count].decode('ascii')
        return {'version': version, 'raw': values,
                'values': dict(zip(FUSE_NAMES, values))}


def write_minimal_asar(path):
    sources = {
        'package.json': json.dumps({'name': 'codex-mobile-loader-probe',
                                   'version': '0.0.0', 'main': 'probe.cjs'}).encode(),
        'probe.cjs': b"require('node:fs').writeFileSync(process.env.CODEX_MOBILE_PROBE_MARKER, 'loaded');require('electron').app.exit(0);",
    }
    offset = 0
    entries = {}
    for name, data in sources.items():
        digest = hashlib.sha256(data).hexdigest()
        entries[name] = {'size': len(data), 'offset': str(offset),
                         'integrity': {'algorithm': 'SHA256', 'hash': digest,
                                       'blockSize': 4 * 1024 * 1024, 'blocks': [digest]}}
        offset += len(data)
    header = json.dumps({'files': entries}, separators=(',', ':')).encode()
    padded = (len(header) + 3) & ~3
    pickle_data = struct.pack('<II', padded + 4, len(header)) + header + bytes(padded - len(header))
    path.write_bytes(struct.pack('<II', 4, len(pickle_data)) + pickle_data + b''.join(sources.values()))


def bind_test_archive(executable, archive):
    """Set the expected archive digest in the disposable copy, keeping checks on.

    This changes the copy's Authenticode hash. It is an unsigned local experiment,
    not a way to update the installed/signed product.
    """
    data = archive.read_bytes()
    header_length = struct.unpack_from('<I', data, 12)[0]
    digest = hashlib.sha256(data[16:16 + header_length]).hexdigest().encode()
    binary = executable.read_bytes()
    matches = list(re.finditer(rb'"alg":"SHA256","value":"([0-9a-f]{64})"', binary))
    if len(matches) != 1:
        raise ValueError('Expected exactly one embedded archive digest')
    start, end = matches[0].span(1)
    executable.chmod(stat.S_IREAD | stat.S_IWRITE)
    executable.write_bytes(binary[:start] + digest + binary[end:])
    return digest.decode()


def main():
    source = Path(subprocess.check_output(
        ['powershell', '-NoProfile', '-Command',
         '(Get-AppxPackage OpenAI.Codex | Select-Object -First 1).InstallLocation'],
        text=True).strip()) / 'app'
    if not (source / 'ChatGPT.exe').is_file():
        raise RuntimeError('Installed runtime unavailable')
    base = ROOT / 'runtime' / 'desktop-prototype' / ('loader-' + uuid.uuid4().hex[:12])
    app = base / 'app'
    (app / 'resources').mkdir(parents=True)
    # Copies, never hard links: subsequent experiments cannot alter the original.
    for file in source.iterdir():
        if file.is_file():
            shutil.copy2(file, app / file.name)
    (app / 'locales').mkdir()
    for name in ['en-US.pak', 'zh-CN.pak']:
        if (source / 'locales' / name).is_file():
            shutil.copy2(source / 'locales' / name, app / 'locales' / name)
    write_minimal_asar(app / 'resources' / 'app.asar')
    shutil.copy2(app / 'ChatGPT.exe', app / 'CodexMobileOriginal.exe')
    digest = bind_test_archive(app / 'ChatGPT.exe', app / 'resources' / 'app.asar')
    marker = base / 'loaded.txt'
    env = dict(os.environ)
    env.update(CODEX_MOBILE_PROBE_MARKER=str(marker),
               CODEX_ELECTRON_USER_DATA_PATH=str(base / 'profile'),
               CODEX_HOME=str(base / 'isolated-codex-home'))
    env.pop('NODE_OPTIONS', None)
    env.pop('ELECTRON_RUN_AS_NODE', None)
    contain_process_tree()
    ctypes.windll.kernel32.SetErrorMode(0x0001 | 0x0002 | 0x8000)
    start = subprocess.STARTUPINFO()
    start.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    start.wShowWindow = 0
    args = [str(app / 'ChatGPT.exe'), '--no-error-dialogs', '--disable-breakpad',
            '--enable-logging=stderr', '--user-data-dir=' + str(base / 'profile')]
    def attempt(name, executable):
        stderr = base / (name + '-stderr.log')
        with (base / (name + '-stdout.log')).open('wb') as out, stderr.open('wb') as err:
            child = subprocess.Popen([str(executable), *args[1:]], env=env, cwd=app, stdout=out, stderr=err,
                                     startupinfo=start, creationflags=subprocess.CREATE_NO_WINDOW)
            timed_out = False
            try:
                code = child.wait(timeout=20)
            except subprocess.TimeoutExpired:
                timed_out = True
                child.kill()
                code = child.wait(timeout=5)
        return {'markerCreated': marker.exists(), 'exitCode': code, 'timedOut': timed_out,
                'stderrTail': stderr.read_text(errors='replace')[-6000:]}

    original_check = attempt('original-integrity', app / 'CodexMobileOriginal.exe')
    local_build = attempt('local-build-integrity', app / 'ChatGPT.exe')
    result = {'installation': source.parent.name, 'fuses': read_fuses(source / 'chrome.dll'),
              'originalIntegrity': original_check, 'localBuildIntegrity': local_build,
              'localBuildArchiveDigest': digest, 'localExecutableSignatureChanged': True,
              'installedFilesModified': False, 'runtimeDirectory': str(base),
              'sharedSubmissionEnabled': False}
    (base / 'result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
