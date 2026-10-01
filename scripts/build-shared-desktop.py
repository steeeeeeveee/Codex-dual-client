"""Build a pinned local desktop with a narrow mobile owner API, without replacing Store files."""
import hashlib
import argparse
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from desktop_bridge.inspection import AsarArchive
from desktop_bridge.lab_patch import patch_sources

def module(name,file):
    spec=importlib.util.spec_from_file_location(name,ROOT/'scripts'/file)
    value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--no-activate',action='store_true',help='Build a staged copy without changing the live launcher')
    args=parser.parse_args()
    source=Path(subprocess.check_output(['powershell','-NoProfile','-Command','(Get-AppxPackage OpenAI.Codex | Select-Object -First 1).InstallLocation'],text=True).strip())
    archive=source/'app/resources/app.asar'
    patches=patch_sources(AsarArchive(archive),shared=True)
    digest=hashlib.sha256(b''.join(k.encode()+v for k,v in sorted(patches.items()))).hexdigest()
    base=ROOT/'runtime/desktop-shared'/digest[:12]
    base.mkdir(parents=True,exist_ok=True)
    manifest_file=base/'manifest.json'
    if not manifest_file.exists():
        destination=base/'app'
        if destination.exists():raise RuntimeError('Incomplete build exists; preserve it for diagnosis')
        shutil.copytree(source/'app',destination,ignore=shutil.ignore_patterns('app.asar'))
        module('desktop_builder','build-desktop-lab.py').rebuild_archive(archive,destination/'resources/app.asar',patches)
        header_digest=module('desktop_loader','probe-desktop-loader.py').bind_test_archive(destination/'ChatGPT.exe',destination/'resources/app.asar')
        manifest=dict(base=str(base),executable=str(destination/'ChatGPT.exe'),sourceInstallation=str(source),
            profile=str(ROOT/'runtime/desktop-shared/profile'),codexHome=str(Path.home()/'.codex'),
            pipe=r'\\.\pipe\codex-mobile-shared-desktop',build=digest,archiveDigest=header_digest,
            executableDigest=hashlib.sha256((destination/'ChatGPT.exe').read_bytes()).hexdigest(),
            signature='modified-local-copy',protocol='mobile-queue-v2')
        manifest_file.write_text(json.dumps(manifest,indent=2),encoding='utf-8')
    if not args.no_activate:
        (ROOT/'runtime/shared-desktop.json').write_text(json.dumps({'manifest':str(manifest_file)}),encoding='utf-8')
    print(json.dumps({'manifest':str(manifest_file),'build':digest[:12]}))

if __name__=='__main__':main()
