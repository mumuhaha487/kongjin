param([string]$SourceDirectory = 'extension/dist-android')
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/Use-Toolchain.ps1"
$KjOutput = Join-Path $KjRoot 'release'
New-Item -ItemType Directory -Force -Path $KjOutput | Out-Null
$KjBuilt = Join-Path $KjRoot 'android/app/build/outputs/apk/release/app-release.apk'
$KjBadging = & "$env:ANDROID_HOME/build-tools/35.0.0/aapt2.exe" dump badging $KjBuilt
if ($LASTEXITCODE -ne 0 -or $KjBadging[0] -notmatch "versionCode='12'.*versionName='1.4.2'") { throw 'Wrong APK version' }
$KjCert = & "$env:ANDROID_HOME/build-tools/35.0.0/apksigner.bat" verify --verbose --print-certs $KjBuilt
if ($LASTEXITCODE -ne 0) { throw 'APK signature verification failed' }
$KjHash = (Get-FileHash -LiteralPath $KjBuilt -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText((Join-Path $KjOutput 'android.url'), "[InternetShortcut]`r`nURL=https://kongjing.inc.re/download/android`r`n", [Text.Encoding]::ASCII)
$KjCert | Write-Output
Write-Output "APK: $KjBuilt"
Write-Output "Download: https://kongjing.inc.re/download/android"
Write-Output "SHA-256: $KjHash"
