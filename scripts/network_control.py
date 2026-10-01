"""Only operate the Codex mobile daemon's private named pipe."""
import json
import subprocess
import time

CLI = [r'C:\Program Files\Tailscale\tailscale.exe',
       r'--socket=\\.\pipe\CodexMobileTailscale']


def command(*args, timeout=12):
    return subprocess.run(CLI + list(args), capture_output=True, text=True,
                          encoding='utf-8', errors='replace', timeout=timeout,
                          creationflags=subprocess.CREATE_NO_WINDOW)


def read_status():
    result = command('status', '--json')
    if result.returncode:
        raise RuntimeError('The private Codex Tailscale daemon is unavailable.')
    status = json.loads(result.stdout)
    if not isinstance(status, dict):
        raise ValueError('Invalid private Tailscale status')
    return status


def recovery_state(status):
    state = status.get('BackendState')
    if state in ('NeedsLogin', 'NeedsMachineAuth'):
        return 'login_required'
    if state == 'Stopped':
        return 'stopped'
    if state == 'Running' and (status.get('Self') or {}).get('Online') is True:
        return 'healthy'
    return 'offline'


def reconnect():
    # This Windows CLI requires every existing non-default flag when a timeout
    # is supplied. Never reset preferences or force a new authentication.
    return command('up', '--timeout=20s', '--accept-dns=false',
                   '--accept-routes=false', '--hostname=codex-mobile',
                   '--unattended', timeout=25).returncode == 0


class RecoveryMonitor:
    def __init__(self):
        self.failures = 0
        self.next_connect = 0
        self.next_restart = 0
        self.previous = None

    def check(self, proc, log, now=None):
        now = time.monotonic() if now is None else now
        try:
            state = recovery_state(read_status())
        except (OSError, RuntimeError, ValueError, subprocess.TimeoutExpired):
            state = 'unavailable'
        if state != self.previous:
            log.info('Private network state: %s', state)
            self.previous = state
        if state in ('healthy', 'login_required'):
            self.failures = 0
            return
        if state == 'stopped' and now >= self.next_connect:
            self.next_connect = now + 60
            try:
                if reconnect():
                    log.info('Reconnected private network with existing settings')
                    self.failures = 0
                    return
            except (OSError, subprocess.TimeoutExpired):
                pass
        self.failures += 1
        # Three failed checks tolerate brief outages. Limit retries during a
        # longer internet outage, and terminate only our own child process.
        if self.failures >= 3 and now >= self.next_restart and proc.poll() is None:
            log.warning('Private connection remained unavailable; restarting own daemon')
            proc.terminate()
            self.failures = 0
            self.next_restart = now + 300


def repair():
    try:
        state = recovery_state(read_status())
        if state == 'login_required':
            print('Tailscale requires account login or device approval. Existing account was preserved.')
            return 2
        if state == 'stopped':
            if not reconnect():
                raise RuntimeError('Private Tailscale reconnect did not complete.')
        deadline = time.monotonic() + 30
        while recovery_state(read_status()) != 'healthy':
            if time.monotonic() >= deadline:
                raise RuntimeError('Private network is still offline. Check computer internet access.')
            time.sleep(2)
        result = command('serve', '--bg', '--https=443', 'http://127.0.0.1:8767', timeout=20)
        if result.returncode:
            raise RuntimeError('Private HTTPS forwarding could not be restored.')
        print('Codex mobile Tailscale is online. Private HTTPS forwarding is ready.')
        return 0
    except (OSError, RuntimeError, ValueError, subprocess.TimeoutExpired) as exc:
        print(str(exc))
        return 1


if __name__ == '__main__':
    raise SystemExit(repair())
