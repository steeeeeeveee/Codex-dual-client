param([switch]$ReplaceRunning)
$ErrorActionPreference = 'Stop'
$mobileRoot = Split-Path -Parent $PSScriptRoot
$mobileRuntime = Join-Path $mobileRoot 'runtime'
$mobileState = Join-Path $mobileRuntime 'tailscale'
New-Item -ItemType Directory -Path $mobileState -Force | Out-Null
try {
    $mobileIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $mobileRunner = Join-Path $PSScriptRoot 'run-network.py'
    $mobileAction = New-ScheduledTaskAction -Execute (Join-Path $mobileRoot '.venv\Scripts\pythonw.exe') -Argument ('"' + $mobileRunner + '"') -WorkingDirectory $mobileRoot
    $mobileTrigger = New-ScheduledTaskTrigger -AtLogOn -User $mobileIdentity
    $mobileSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([timespan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    $mobilePrincipal = New-ScheduledTaskPrincipal -UserId $mobileIdentity -LogonType Interactive -RunLevel Highest
    $mobileExisting = Get-ScheduledTask -TaskName 'Codex-Mobile-Private-Network' -ErrorAction SilentlyContinue
    if ($mobileExisting) {
        $mobileLegacy = $mobileExisting.Actions.Execute -eq 'C:\Program Files\Tailscale\tailscaled.exe' -and $mobileExisting.Actions.Arguments -like '*--socket=\\.\pipe\CodexMobileTailscale*' -and $mobileExisting.Actions.WorkingDirectory -eq $mobileRoot
        $mobileOwned = $mobileExisting.Actions.Execute -eq $mobileAction.Execute -and $mobileExisting.Actions.Arguments -eq $mobileAction.Arguments
        if (-not ($mobileLegacy -or $mobileOwned)) { throw 'Task name already exists with unrelated arguments.' }
        if ($mobileExisting.State -eq 'Running') {
            if (-not $ReplaceRunning) { throw 'Network task is already running. No changes made.' }
            Stop-ScheduledTask -TaskName 'Codex-Mobile-Private-Network'
            $mobileDeadline = (Get-Date).AddSeconds(20)
            do {
                Start-Sleep -Milliseconds 500
                $mobilePipeExists = Test-Path -LiteralPath '\\.\pipe\CodexMobileTailscale'
            } while ($mobilePipeExists -and (Get-Date) -lt $mobileDeadline)
            if ($mobilePipeExists) { throw 'Old private network daemon did not stop; refusing to start a second copy.' }
        }
    }
    Register-ScheduledTask -TaskName 'Codex-Mobile-Private-Network' -Action $mobileAction -Trigger $mobileTrigger -Settings $mobileSettings -Principal $mobilePrincipal -Description 'Independent private Codex mobile network. No TUN adapter and no shuttle configuration changes.' -Force | Out-Null
    Start-ScheduledTask -TaskName 'Codex-Mobile-Private-Network'
    @{ok=$true;time=(Get-Date).ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $mobileRuntime 'network-install.json') -Encoding UTF8
} catch {
    @{ok=$false;error=$_.Exception.Message} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $mobileRuntime 'network-install.json') -Encoding UTF8
    throw
}
