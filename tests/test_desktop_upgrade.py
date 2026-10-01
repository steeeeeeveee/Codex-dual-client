import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, Mock, patch
from desktop_launch import upgrade_status

spec = importlib.util.spec_from_file_location('upgrade', Path(__file__).resolve().parents[1] / 'scripts/activate-desktop-upgrade.py')
upgrade = importlib.util.module_from_spec(spec)
spec.loader.exec_module(upgrade)


class UpgradeTests(unittest.IsolatedAsyncioTestCase):
    async def test_waits_for_natural_exit_then_validates_and_launches_once(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            old = root / 'runtime/desktop-shared/old/manifest.json'
            new = root / 'runtime/desktop-shared/new/manifest.json'
            for file in (old, new):
                file.parent.mkdir(parents=True)
                file.write_text(json.dumps({'executable': str(file.parent / 'app/ChatGPT.exe'), 'build': file.parent.name}))
            pointer = root / 'runtime/shared-desktop.json'
            previous = {'manifest': str(old)}
            pointer.write_text(json.dumps(previous))
            observed = []
            async def waiting(_):
                observed.append(json.loads(pointer.read_text()))
            launcher = Mock()
            adapter = Mock(call=AsyncMock(return_value={'protocol': 'mobile-compose-v1'}), close=AsyncMock())
            with patch.object(upgrade, 'ROOT', root), patch.object(upgrade, 'desktop_running', side_effect=[True, False]), patch.object(upgrade.asyncio, 'sleep', side_effect=waiting), patch.object(upgrade.importlib.util, 'module_from_spec', return_value=launcher), patch.object(upgrade.importlib.util, 'spec_from_file_location', return_value=Mock()), patch.object(upgrade, 'request_open', new_callable=AsyncMock) as launch, patch.object(upgrade, 'DesktopAdapter', return_value=adapter):
                await upgrade.activate(new, None)
            self.assertEqual(observed, [previous])
            launcher.load_manifest.assert_called_once()
            launch.assert_awaited_once_with(None)
            self.assertEqual(json.loads(pointer.read_text()), {'manifest': str(new.resolve())})
            self.assertEqual(json.loads((root / 'runtime/shared-desktop.before-compose.json').read_text()), previous)
            self.assertEqual(json.loads((root / 'runtime/desktop-upgrade.json').read_text())['status'], 'ready')

    async def test_rejects_outside_manifest_before_launch(self):
        with self.assertRaises(ValueError):
            await upgrade.activate(Path(__file__).resolve(), None)

    def test_inaccessible_process_is_treated_as_running(self):
        process = Mock(stdout='{"ExecutablePath":null}')
        with patch.object(upgrade.subprocess, 'run', return_value=process):
            self.assertTrue(upgrade.desktop_running(Path('C:/test/ChatGPT.exe')))

    def test_late_readiness_clears_only_matching_failed_upgrade(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state = root / 'desktop-upgrade.json'
            pointer = root / 'shared-desktop.json'
            state.write_text(json.dumps({'status':'failed','manifest':'new','build':'new','reason':'timed out'}))
            pointer.write_text(json.dumps({'manifest':'other'}))
            ready = {'protocol':'mobile-compose-v1','desktop':{'connected':True}}
            self.assertEqual(upgrade_status(root, ready)['status'], 'failed')
            pointer.write_text(json.dumps({'manifest':'new'}))
            self.assertEqual(upgrade_status(root, {})['status'], 'failed')
            self.assertEqual(upgrade_status(root, ready)['status'], 'ready')
            self.assertNotIn('reason', json.loads(state.read_text()))

    def test_interactive_desktop_launch_is_visible(self):
        module_spec = importlib.util.spec_from_file_location('launch_test', Path(__file__).resolve().parents[1] / 'scripts/launch-shared-desktop.py')
        launcher = importlib.util.module_from_spec(module_spec)
        module_spec.loader.exec_module(launcher)
        manifest = {'executable':'C:/test/app/ChatGPT.exe','base':'C:/test','codexHome':'C:/test/home','profile':'C:/test/profile'}
        with patch.object(launcher, 'load_manifest', return_value=manifest), patch.object(launcher.subprocess, 'Popen') as popen:
            launcher.launch()
        self.assertEqual(popen.call_args.kwargs['startupinfo'].wShowWindow, 1)


if __name__ == '__main__':
    unittest.main()
