param([switch]$Apply)
$ErrorActionPreference = 'Stop'
$KjWorkspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
& node (Join-Path $PSScriptRoot 'check-release.mjs') --allow-extra
if ($LASTEXITCODE -ne 0) { throw 'Verify all four current products before cleanup.' }
$KjKeep = @('kongjing.crx','kongjing.zip','android.url','source.zip')
$KjReleaseRoot = (Resolve-Path -LiteralPath (Join-Path $KjWorkspace 'release')).Path
if (!$KjReleaseRoot.Equals((Join-Path $KjWorkspace 'release'), [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe release directory' }
$KjEntries = @(Get-ChildItem -LiteralPath $KjReleaseRoot -Recurse -Force)
foreach ($KjEntry in @((Get-Item -LiteralPath $KjReleaseRoot)) + $KjEntries) {
    if ($KjEntry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing linked cleanup target' }
    if (!$KjEntry.FullName.Equals($KjReleaseRoot, [StringComparison]::OrdinalIgnoreCase) -and !$KjEntry.FullName.StartsWith($KjReleaseRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe cleanup target' }
}
$KjOldFiles = @($KjEntries | Where-Object { !$_.PSIsContainer -and ($_.DirectoryName -ne $KjReleaseRoot -or $_.Name -notin $KjKeep) })
Write-Output "Obsolete release files: $($KjOldFiles.Count)"
foreach ($KjFile in $KjOldFiles) {
    Write-Output $KjFile.FullName
    if ($Apply) { Remove-Item -LiteralPath $KjFile.FullName -Force }
}
foreach ($KjDirectory in @($KjEntries | Where-Object PSIsContainer | Sort-Object { $_.FullName.Length } -Descending)) {
    if ($Apply -and !(Get-ChildItem -LiteralPath $KjDirectory.FullName -Force)) { Remove-Item -LiteralPath $KjDirectory.FullName -Force }
}
if ($Apply) {
    & node (Join-Path $PSScriptRoot 'check-release.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Final release verification failed' }
}
