$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'Installer smoke test is restricted to an ephemeral GitHub runner' }
$installer = @(Get-ChildItem release-artifacts -Filter *.exe)
if ($installer.Count -ne 1) { throw 'Expected one Windows installer' }
$directory = Join-Path $env:RUNNER_TEMP 'Peek Desktop 安装验收'
$process = Start-Process -FilePath $installer[0].FullName -ArgumentList "/S /D=$directory" -Wait -PassThru
if ($process.ExitCode -ne 0) { throw "Installer exited with $($process.ExitCode)" }
$exe = Join-Path $directory 'peek-desktop.exe'
if (-not (Test-Path -LiteralPath $exe)) { throw 'Application executable was not installed' }
foreach ($filename in @('LICENSE', 'THIRD_PARTY_NOTICES.md')) {
  $file = Join-Path $directory "licenses\$filename"
  if (-not (Test-Path -LiteralPath $file) -or (Get-Item -LiteralPath $file).Length -eq 0) { throw 'License resource is missing' }
}
$associations = @{}
foreach ($extension in @('peek', 'peekbundle')) {
  $key = Get-Item -LiteralPath "HKCU:\Software\Classes\.$extension"
  $type = $key.GetValue('')
  if (-not $type) { throw "Missing .$extension association" }
  $associations[$extension] = $type
  $command = (Get-Item -LiteralPath "HKCU:\Software\Classes\$type\shell\open\command").GetValue('')
  if ($command -notmatch [regex]::Escape($exe) -or $command -notmatch '"%1"') { throw "Invalid .$extension command" }
}
$uninstall = @(Get-ChildItem -LiteralPath $directory -Filter '*uninstall*.exe')
if ($uninstall.Count -ne 1) { throw 'Uninstaller was not installed' }
$process = Start-Process -FilePath $uninstall[0].FullName -ArgumentList '/S' -Wait -PassThru
if ($process.ExitCode -ne 0) { throw "Uninstaller exited with $($process.ExitCode)" }
if (Test-Path -LiteralPath $exe) { throw 'Application executable remains after uninstall' }
foreach ($type in $associations.Values) {
  if (Test-Path -LiteralPath "HKCU:\Software\Classes\$type\shell\open\command") { throw 'Association command remains after uninstall' }
}
Write-Output 'NSIS install, quoted file associations and uninstall passed'
