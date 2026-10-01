"""Supervise this project's private daemon, including unexpected clean exits."""
import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path
import subprocess
import threading
import time
from network_control import RecoveryMonitor
from windows_job import contain_process_tree


ROOT = Path(__file__).resolve().parents[1]
STATE = ROOT / 'runtime' / 'tailscale'
COMMAND = [
    r'C:\Program Files\Tailscale\tailscaled.exe',
    '--tun=userspace-networking', '--port=0',
    r'--socket=\\.\pipe\CodexMobileTailscale',
    f'--state={STATE / "state.conf"}', f'--statedir={STATE}',
]


def main():
    STATE.mkdir(parents=True, exist_ok=True)
    log = logging.getLogger('mobile-network')
    log.setLevel(logging.INFO)
    handler = RotatingFileHandler(ROOT / 'runtime' / 'network.log',
                                  maxBytes=2_000_000, backupCount=2, encoding='utf-8')
    handler.setFormatter(logging.Formatter('%(asctime)s %(message)s'))
    log.addHandler(handler)
    monitor = RecoveryMonitor()
    delay = 2
    while True:
        started = time.monotonic()
        try:
            with subprocess.Popen(COMMAND, cwd=ROOT, stdin=subprocess.DEVNULL,
                                  stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                  text=True, encoding='utf-8', errors='replace',
                                  creationflags=subprocess.CREATE_NO_WINDOW) as proc:
                log.info('Started private daemon pid=%s', proc.pid)
                def drain(stream):
                    for line in stream:
                        log.info('%s', line.rstrip())
                reader = threading.Thread(target=drain, args=(proc.stdout,), daemon=True)
                reader.start()
                while True:
                    try:
                        result = proc.wait(timeout=30)
                        break
                    except subprocess.TimeoutExpired:
                        monitor.check(proc, log)
                reader.join(timeout=5)
            log.warning('Private daemon exited code=%s; restarting', result)
        except OSError:
            log.exception('Private daemon could not start')
        if time.monotonic() - started >= 60:
            delay = 2
        time.sleep(delay)
        delay = min(delay * 2, 60)


if __name__ == '__main__':
    process_tree_job = contain_process_tree()
    main()
