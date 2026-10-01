$ErrorActionPreference = 'Stop'
$mobileRoot = Split-Path -Parent $PSScriptRoot
$mobilePython = Join-Path $mobileRoot '.venv\Scripts\pythonw.exe'
$mobileHost = '"' + (Join-Path $PSScriptRoot 'desktop-host.py') + '"'
$mobileExisting = Get-ScheduledTask -TaskName 'Codex-Mobile-Desktop' -ErrorAction SilentlyContinue
if ($mobileExisting) {
    if ($mobileExisting.Actions.Execute -ne $mobilePython -or $mobileExisting.Actions.Arguments -ne $mobileHost) { throw 'Unrelated desktop task exists; left unchanged.' }
} else {
    $mobileAction = New-ScheduledTaskAction -Execute $mobilePython -Argument $mobileHost -WorkingDirectory $mobileRoot
    $mobilePrincipal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
    $mobileSettings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName 'Codex-Mobile-Desktop' -Action $mobileAction -Principal $mobilePrincipal -Settings $mobileSettings -Description '本机 Codex 双端共用桌面的独立启动器；保留原安装和历史。' | Out-Null
}
$mobileShell = New-Object -ComObject WScript.Shell
$mobileShortcutPath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Codex 双端共用.lnk'
if (Test-Path -LiteralPath $mobileShortcutPath) {
    $mobileOldShortcut = $mobileShell.CreateShortcut($mobileShortcutPath)
    if ($mobileOldShortcut.TargetPath -ne $mobilePython) { throw 'Unrelated shortcut exists; left unchanged.' }
}
$mobileShortcut = $mobileShell.CreateShortcut($mobileShortcutPath)
$mobileShortcut.TargetPath = $mobilePython
$mobileShortcut.Arguments = '"' + (Join-Path $PSScriptRoot 'start-shared-desktop.py') + '"'
$mobileShortcut.WorkingDirectory = $mobileRoot
$mobileShortcut.Description = '沿用原对话，支持电脑与私人手机页面共同排队'
$mobilePointer = Get-Content -LiteralPath (Join-Path $mobileRoot 'runtime\shared-desktop.json') -Raw | ConvertFrom-Json
$mobileManifest = Get-Content -LiteralPath $mobilePointer.manifest -Raw | ConvertFrom-Json
$mobileShortcut.IconLocation = $mobileManifest.executable + ',0'
$mobileShortcut.Save()
Write-Output 'Compatible desktop launcher installed; original shortcut unchanged.'
