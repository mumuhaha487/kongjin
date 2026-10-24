param([string]$SourceDirectory = 'extension/dist-android')
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/Use-Toolchain.ps1"
$KjOutput = Join-Path $KjRoot 'release/android'
New-Item -ItemType Directory -Force -Path $KjOutput | Out-Null
$KjBuilt = Join-Path $KjRoot 'android/app/build/outputs/apk/release/app-release.apk'
$KjApk = Join-Path $KjOutput 'kongjing-browser-1.4.1.apk'
$KjBadging = & "$env:ANDROID_HOME/build-tools/35.0.0/aapt2.exe" dump badging $KjBuilt
if ($LASTEXITCODE -ne 0 -or $KjBadging[0] -notmatch "versionCode='11'.*versionName='1.4.1'") { throw 'Wrong APK version' }
$KjCert = & "$env:ANDROID_HOME/build-tools/35.0.0/apksigner.bat" verify --verbose --print-certs $KjBuilt
if ($LASTEXITCODE -ne 0) { throw 'APK signature verification failed' }
Copy-Item -LiteralPath $KjBuilt -Destination $KjApk
$KjCert | Set-Content -LiteralPath "$KjOutput/signature.txt" -Encoding utf8
$KjBadging | Set-Content -LiteralPath "$KjOutput/badging.txt" -Encoding utf8
$KjHash = (Get-FileHash -LiteralPath $KjApk -Algorithm SHA256).Hash.ToLowerInvariant()
"$KjHash  kongjing-browser-1.4.1.apk" | Set-Content -LiteralPath "$KjApk.sha256" -Encoding ascii
Write-Output "APK: $KjApk"
Write-Output "SHA-256: $KjHash"
