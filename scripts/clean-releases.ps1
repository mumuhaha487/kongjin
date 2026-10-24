param([switch]$Apply)
$ErrorActionPreference = 'Stop'
$KjWorkspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$KjZip = Join-Path $KjWorkspace 'release/store/kongjing-2.1.0-store.zip'
$KjApk = Join-Path $KjWorkspace 'release/android/kongjing-browser-1.4.1.apk'
foreach ($KjCurrent in @($KjZip,$KjApk)) {
    if (!(Test-Path -LiteralPath $KjCurrent) -or (Get-Item -LiteralPath $KjCurrent).Length -lt 10000) { throw 'Verified current release packages must exist before cleanup.' }
}
$KjExpectedHash = (Get-Content -LiteralPath "$KjApk.sha256").Split(' ')[0]
if ((Get-FileHash -LiteralPath $KjApk -Algorithm SHA256).Hash.ToLowerInvariant() -ne $KjExpectedHash) { throw 'Current APK checksum does not match.' }
$KjKeep = @('store/kongjing-2.1.0-store.zip','store/kongjing-2.1.0-store.zip.sha256','store/STORE.md','android/kongjing-browser-1.4.1.apk','android/kongjing-browser-1.4.1.apk.sha256','android/signature.txt','android/badging.txt','SHA256SUMS')
$KjReleaseRoot = Join-Path $KjWorkspace 'release'
$KjOldFiles = @(Get-ChildItem -LiteralPath $KjReleaseRoot -Recurse -File | Where-Object { ($_.FullName.Substring($KjReleaseRoot.Length + 1).Replace('\','/')) -notin $KjKeep -and !$_.FullName.StartsWith((Join-Path $KjReleaseRoot 'store/assets/')) })
foreach ($KjModule in @('relay','edge')) {
    $KjDownloads = Join-Path $KjWorkspace "$KjModule/public/download"
    if (Test-Path -LiteralPath $KjDownloads) {
        $KjOldFiles += @(Get-ChildItem -LiteralPath $KjDownloads -File | Where-Object { $_.Name -match '\.(zip|crx|apk)(\.sha256)?$' -and $_.Name -notmatch '^(kongjing-2\.1\.0-store\.zip|kongjing-browser-1\.4\.1\.apk)(\.sha256)?$' })
    }
}
Write-Output "Obsolete release files: $($KjOldFiles.Count)"
foreach ($KjFile in $KjOldFiles) {
    $KjResolved = (Resolve-Path -LiteralPath $KjFile.FullName).Path
    if (!$KjResolved.StartsWith($KjWorkspace + [IO.Path]::DirectorySeparatorChar)) { throw 'Unsafe cleanup target' }
    if ($KjFile.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing a linked cleanup target' }
    Write-Output $KjResolved
    if ($Apply) { Remove-Item -LiteralPath $KjResolved -Force }
}
foreach ($KjRelative in @('release/unpacked','extension/dist','extension/dist-qa','extension/dist-store-qa')) {
    $KjTarget = Join-Path $KjWorkspace $KjRelative
    if (Test-Path -LiteralPath $KjTarget) {
        $KjResolved = (Resolve-Path -LiteralPath $KjTarget).Path
        if (!$KjResolved.StartsWith($KjWorkspace + [IO.Path]::DirectorySeparatorChar)) { throw 'Unsafe directory cleanup target' }
        if ((Get-Item -LiteralPath $KjResolved).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing linked cleanup directory' }
        Write-Output $KjResolved
        if ($Apply) { Remove-Item -LiteralPath $KjResolved -Recurse -Force }
    }
}
