$ErrorActionPreference = 'Stop'
$mobileRoot = Split-Path -Parent $PSScriptRoot
try {
    $mobileTask = Get-ScheduledTask -TaskName 'Codex-Mobile-Private-Network' -ErrorAction Stop
    $mobileRunner = '"' + (Join-Path $PSScriptRoot 'run-network.py') + '"'
    if ($mobileTask.Actions.Execute -ne (Join-Path $mobileRoot '.venv\Scripts\pythonw.exe') -or $mobileTask.Actions.Arguments -ne $mobileRunner) {
        throw 'Private network task does not match this project. No changes made.'
    }
    if ($mobileTask.State -ne 'Running') { Start-ScheduledTask -TaskName 'Codex-Mobile-Private-Network' }
    & (Join-Path $PSScriptRoot 'start-server.ps1')
    $mobileDeadline = (Get-Date).AddSeconds(20)
    while (-not (Test-Path -LiteralPath '\\.\pipe\CodexMobileTailscale')) {
        if ((Get-Date) -gt $mobileDeadline) { throw 'Private Tailscale did not start. See runtime/network.log.' }
        Start-Sleep -Seconds 1
    }
    & (Join-Path $mobileRoot '.venv\Scripts\python.exe') (Join-Path $PSScriptRoot 'network_control.py')
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    $mobilePage = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8767' -TimeoutSec 10
    if ($mobilePage.StatusCode -ne 200) { throw 'The mobile web page is not ready.' }
    Write-Output 'Ready: open the private HTTPS address configured for this installation.'
} catch {
    Write-Error $_
    exit 1
}
