param([Parameter(Mandatory=$true)][string]$Manifest, [string]$Thread)
$ErrorActionPreference = 'Stop'
$mobileRoot = Split-Path -Parent $PSScriptRoot
$mobileManifest = (Resolve-Path -LiteralPath $Manifest).Path
$mobileParent = [IO.Path]::GetFullPath((Join-Path $mobileRoot 'runtime\desktop-shared')) + [IO.Path]::DirectorySeparatorChar
if (-not $mobileManifest.StartsWith($mobileParent, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($mobileManifest) -ne 'manifest.json') { throw 'Invalid staged desktop manifest' }
if ($Thread -and $Thread -notmatch '^[0-9a-f-]{36}$') { throw 'Invalid thread ID' }
$mobilePython = Join-Path $mobileRoot '.venv\Scripts\pythonw.exe'
$mobileScript = Join-Path $PSScriptRoot 'activate-desktop-upgrade.py'
$mobileArguments = '"' + $mobileScript + '" --manifest "' + $mobileManifest + '"'
if ($Thread) { $mobileArguments += ' --thread ' + $Thread }
$mobileExisting = Get-ScheduledTask -TaskName 'Codex-Mobile-Upgrade' -ErrorAction SilentlyContinue
if ($mobileExisting) {
    if ($mobileExisting.Actions.Execute -ne $mobilePython -or -not $mobileExisting.Actions.Arguments.StartsWith(('"' + $mobileScript + '" '))) { throw 'Unrelated upgrade task exists; left unchanged' }
    if ($mobileExisting.State -eq 'Running') { throw 'An upgrade is already waiting; left unchanged' }
}
$mobileAction = New-ScheduledTaskAction -Execute $mobilePython -Argument $mobileArguments -WorkingDirectory $mobileRoot
$mobilePrincipal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$mobileSettings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 25) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'Codex-Mobile-Upgrade' -Action $mobileAction -Principal $mobilePrincipal -Settings $mobileSettings -Description 'Wait for the old compatible desktop to exit naturally, then activate the verified staged build; never stop running work.' -Force | Out-Null
Start-ScheduledTask -TaskName 'Codex-Mobile-Upgrade'
Write-Output 'Upgrade prepared; waiting for the old desktop to exit naturally.'
