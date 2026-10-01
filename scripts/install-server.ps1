$ErrorActionPreference = 'Stop'
$mobileRoot = Split-Path -Parent $PSScriptRoot
$mobileIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$mobileAction = New-ScheduledTaskAction -Execute (Join-Path $mobileRoot '.venv\Scripts\pythonw.exe') -Argument ('"' + (Join-Path $PSScriptRoot 'run-server.py') + '"') -WorkingDirectory $mobileRoot
$mobileTrigger = New-ScheduledTaskTrigger -AtLogOn -User $mobileIdentity
$mobileSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([timespan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$mobilePrincipal = New-ScheduledTaskPrincipal -UserId $mobileIdentity -LogonType Interactive -RunLevel Limited
$mobileExisting = Get-ScheduledTask -TaskName 'Codex-Mobile-Web' -ErrorAction SilentlyContinue
if ($mobileExisting -and $mobileExisting.Actions.Execute -ne $mobileAction.Execute) { throw 'Unrelated task already uses this name.' }
Register-ScheduledTask -TaskName 'Codex-Mobile-Web' -Action $mobileAction -Trigger $mobileTrigger -Settings $mobileSettings -Principal $mobilePrincipal -Description 'Loopback-only private Codex mobile web client.' -Force | Out-Null
