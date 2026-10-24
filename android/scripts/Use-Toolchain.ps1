$ErrorActionPreference = 'Stop'
$KjRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$KjBundledJava = Join-Path $KjRoot '.toolchain/jdk'
$KjBundledSdk = Join-Path $KjRoot '.toolchain/sdk'
if (Test-Path -LiteralPath $KjBundledJava) { $env:JAVA_HOME = $KjBundledJava }
if (Test-Path -LiteralPath $KjBundledSdk) {
    $env:ANDROID_HOME = $KjBundledSdk
    $env:ANDROID_SDK_ROOT = $KjBundledSdk
    $env:ANDROID_USER_HOME = Join-Path $KjRoot '.toolchain/android-user'
    $env:GRADLE_USER_HOME = Join-Path $KjRoot '.toolchain/gradle-home'
}
if (!$env:JAVA_HOME -or !$env:ANDROID_HOME) { throw 'Set JAVA_HOME (JDK 17+) and ANDROID_HOME (SDK 35)' }
$env:Path = "$env:JAVA_HOME/bin;$env:ANDROID_HOME/platform-tools;$env:Path"
