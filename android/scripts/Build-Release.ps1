param([string]$HomeSourceDirectory = 'extension/dist-android')
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/Use-Toolchain.ps1"
$KjLock = Join-Path $KjRoot 'android/test-state/DEVICE.lock'
if ((Test-Path -LiteralPath $KjLock) -and (Get-Item -LiteralPath $KjLock).LastWriteTime -gt (Get-Date).AddHours(-3)) { throw 'A build or device session holds DEVICE.lock; retry after it finishes.' }
$KjOwner = "release-$([guid]::NewGuid())"
New-Item -ItemType Directory -Force -Path (Split-Path $KjLock) | Out-Null
"$KjOwner | $([DateTimeOffset]::Now.ToString('o')) | expected 15 minutes" | Set-Content -LiteralPath $KjLock
try {
    Push-Location $KjRoot
    try {
        & npm.cmd --prefix extension run build:android
        if ($LASTEXITCODE -ne 0) { throw 'Android home build failed' }
        & npm.cmd --prefix android/extension-runtime run build
        if ($LASTEXITCODE -ne 0) { throw 'Extension runtime build failed' }
        & ./android/gradlew.bat -p android testDebugUnitTest lintRelease assembleRelease --console=plain
        if ($LASTEXITCODE -ne 0) { throw 'Tests, lint or release build failed' }
        & "$PSScriptRoot/Package-Release.ps1" -SourceDirectory $HomeSourceDirectory
    } finally { Pop-Location }
} finally {
    if ((Test-Path -LiteralPath $KjLock) -and (Get-Content -LiteralPath $KjLock -Raw).StartsWith($KjOwner)) { Remove-Item -LiteralPath $KjLock }
}
