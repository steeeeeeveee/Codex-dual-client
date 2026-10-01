$ErrorActionPreference = 'Stop'
$mobileRoot = Split-Path -Parent $PSScriptRoot
$mobileListener = Get-NetTCPConnection -State Listen -LocalPort 8767 -ErrorAction SilentlyContinue
if (!$mobileListener) {
    $mobileTask = Get-ScheduledTask -TaskName 'Codex-Mobile-Web' -ErrorAction SilentlyContinue
    if ($mobileTask) { Start-ScheduledTask -TaskName 'Codex-Mobile-Web' }
    else { Start-Process -FilePath (Join-Path $mobileRoot '.venv\Scripts\pythonw.exe') -ArgumentList ('"' + (Join-Path $PSScriptRoot 'run-server.py') + '"') -WorkingDirectory $mobileRoot -WindowStyle Hidden }
}
