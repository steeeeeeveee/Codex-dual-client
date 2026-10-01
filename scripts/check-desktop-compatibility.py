"""Produce a compatibility report; never enables shared queue submission."""
import argparse
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from desktop_bridge.inspection import inspect_desktop


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--archive', type=Path)
    parser.add_argument('--thread-id', help='Optional existing thread for a read-only desktop connection probe')
    parser.add_argument('--output', type=Path, help='Optional destination for metadata-only JSON')
    args = parser.parse_args()
    archive = args.archive
    if archive is None:
        result = subprocess.run(['powershell.exe', '-NoProfile', '-Command',
                                 "Get-AppxPackage 'OpenAI.Codex' | Select-Object -ExpandProperty InstallLocation"],
                                capture_output=True, text=True, check=True, timeout=15,
                                creationflags=subprocess.CREATE_NO_WINDOW)
        locations = [line.strip() for line in result.stdout.splitlines() if line.strip()]
        if len(locations) != 1:
            raise RuntimeError('Expected one installed Codex desktop package; specify --archive explicitly')
        archive = Path(locations[0]) / 'app/resources/app.asar'
    report = inspect_desktop(archive)
    if args.thread_id:
        node = archive.parent / 'cua_node/bin/node.exe'
        result = subprocess.run([str(node), str(ROOT / 'desktop_bridge/probe.mjs'), args.thread_id],
                                capture_output=True, text=True, encoding='utf-8', timeout=30,
                                creationflags=subprocess.CREATE_NO_WINDOW)
        try:
            report['liveProbe'] = json.loads(result.stdout)
        except ValueError:
            report['liveProbe'] = {'error': 'Probe did not return valid metadata', 'exitCode': result.returncode}
    rendered = json.dumps(report, ensure_ascii=False, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered + '\n', encoding='utf-8')
    print(rendered)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
