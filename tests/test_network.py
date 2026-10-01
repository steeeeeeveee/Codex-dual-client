import importlib.util
import logging
from pathlib import Path
import subprocess
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('network_control', Path(__file__).resolve().parents[1] / 'scripts/network_control.py')
network = importlib.util.module_from_spec(spec)
spec.loader.exec_module(network)


class NetworkRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.monitor = network.RecoveryMonitor()
        self.proc = Mock()
        self.proc.poll.return_value = None
        self.log = logging.getLogger('test-network')

    def test_stopped_connection_uses_existing_login_and_preferences(self):
        with patch.object(network, 'read_status', return_value={'BackendState': 'Stopped'}), patch.object(network, 'command') as command:
            command.return_value.returncode = 0
            self.monitor.check(self.proc, self.log, now=100)
        command.assert_called_once_with('up', '--timeout=20s', '--accept-dns=false',
                                        '--accept-routes=false', '--hostname=codex-mobile',
                                        '--unattended', timeout=25)
        self.proc.terminate.assert_not_called()

    def test_login_or_approval_required_does_not_restart_or_reauthenticate(self):
        with patch.object(network, 'reconnect') as reconnect:
            for state in ('NeedsLogin', 'NeedsMachineAuth'):
                with patch.object(network, 'read_status', return_value={'BackendState': state}):
                    for now in (0, 100, 200, 300):
                        self.monitor.check(self.proc, self.log, now=now)
            reconnect.assert_not_called()
        self.proc.terminate.assert_not_called()

    def test_brief_outage_recovers_without_restart(self):
        states = [{'BackendState': 'Running', 'Self': {'Online': False}}] * 2
        states += [{'BackendState': 'Running', 'Self': {'Online': True}}]
        with patch.object(network, 'read_status', side_effect=states):
            for now in (0, 30, 60):
                self.monitor.check(self.proc, self.log, now=now)
        self.proc.terminate.assert_not_called()
        self.assertEqual(self.monitor.failures, 0)

    def test_persistent_outage_restarts_only_owned_child_with_cooldown(self):
        with patch.object(network, 'read_status', side_effect=RuntimeError('unavailable')):
            for now in (0, 30, 60, 90, 120, 150):
                self.monitor.check(self.proc, self.log, now=now)
            self.proc.terminate.assert_called_once_with()
            self.monitor.check(self.proc, self.log, now=360)
            self.assertEqual(self.proc.terminate.call_count, 2)

    def test_cli_always_targets_private_pipe_and_has_timeout(self):
        with patch.object(network.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0)) as run:
            network.command('status', '--json')
        args, kwargs = run.call_args
        self.assertEqual(args[0][1], r'--socket=\\.\pipe\CodexMobileTailscale')
        self.assertEqual(args[0][2:], ['status', '--json'])
        self.assertEqual(kwargs['timeout'], 12)

    def test_repair_reports_failed_https_forwarding(self):
        with patch.object(network, 'read_status', return_value={'BackendState': 'Running', 'Self': {'Online': True}}), patch.object(network, 'command', return_value=subprocess.CompletedProcess([], 1)), patch('builtins.print'):
            self.assertEqual(network.repair(), 1)


if __name__ == '__main__':
    unittest.main()
