import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('restart_test',Path(__file__).resolve().parents[1]/'scripts/restart-shared-desktop.py')
restart=importlib.util.module_from_spec(spec);spec.loader.exec_module(restart)

class DesktopRestartTests(unittest.TestCase):
    def test_only_confirmed_idle_state_allows_restart(self):
        self.assertFalse(restart.busy({'turnId':None,'queue':[],'pending':[]}))
        for state in ({'turnId':'active'},{'queue':[{}]},{'pending':[{}]},{'unsupportedQuestions':1}):
            self.assertTrue(restart.busy(state))
        with self.assertRaises(ValueError):restart.busy(None)

    def test_outside_manifest_is_rejected_before_any_process_operation(self):
        with self.assertRaises(ValueError):restart.verified_manifest(__file__)

    def test_stop_is_scoped_to_validated_project_host(self):
        with patch.object(restart.subprocess,'run') as run:
            restart.stop_project_host()
        command=run.call_args.args[0][-1]
        self.assertIn("Stop-ScheduledTask -TaskName 'Codex-Mobile-Desktop'",command)
        self.assertIn('Unrelated desktop task; preserved',command)
        self.assertNotIn('Stop-Process',command)
        self.assertNotIn('Codex-Mobile-Web',command)
        self.assertEqual(run.call_args.kwargs['env']['CODEX_MOBILE_RESTART_ROOT'],str(restart.ROOT))
