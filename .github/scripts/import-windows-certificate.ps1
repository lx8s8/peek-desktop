$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'Certificate import is restricted to an ephemeral GitHub runner' }
if (-not $env:WINDOWS_CERTIFICATE -or -not $env:WINDOWS_CERTIFICATE_PASSWORD) { throw 'Windows signing certificate is not configured' }
$file = Join-Path $env:RUNNER_TEMP 'peek-signing.pfx'
try {
  [IO.File]::WriteAllBytes($file, [Convert]::FromBase64String($env:WINDOWS_CERTIFICATE))
  $password = ConvertTo-SecureString $env:WINDOWS_CERTIFICATE_PASSWORD -AsPlainText -Force
  $certificates = @(Import-PfxCertificate -FilePath $file -CertStoreLocation Cert:\CurrentUser\My -Password $password)
  $signers = @($certificates | Where-Object { $_.HasPrivateKey -and ($_.EnhancedKeyUsageList.ObjectId -contains '1.3.6.1.5.5.7.3.3') -and $_.NotAfter -gt (Get-Date) })
  if ($signers.Count -ne 1) { throw 'Expected one valid code-signing certificate with a private key' }
  "WINDOWS_CERTIFICATE_THUMBPRINT=$($signers[0].Thumbprint)" | Out-File $env:GITHUB_ENV -Encoding utf8 -Append
} finally {
  if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force }
}
