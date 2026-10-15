<#
.SYNOPSIS
  Installs (or removes) the CCUsageX "Claude Pulse" desktop widget for Rainmeter on Windows.

.DESCRIPTION
  Install: checks that Rainmeter is installed, downloads the NSTechBytes WebView2 plugin from its official GitHub
  release (pinned version, SHA256 verified), puts the plugin in %APPDATA%\Rainmeter\Plugins, copies the skin from
  integrations\rainmeter\ClaudePulse into your Rainmeter Skins folder and activates it with Rainmeter's own bangs.
  No admin rights needed. Safe to run again. Never installs Rainmeter itself. Rainmeter.ini is touched only on the
  first run for this skin (no [ClaudePulse] section yet), to set the skin's default position (step 4).

  The widget loads http://127.0.0.1:<port>/widget.html, so CCUsageX must be running (node server.js).

.PARAMETER Port
  CCUsageX port (1-65535), written into the installed skin's Port= variable. Omit to keep what the skin already has (default 3020).
.PARAMETER StartWithWindows
  Adds a Startup shortcut that launches Rainmeter at logon.
.PARAMETER Uninstall
  Deactivates and removes the skin (and the Startup shortcut this script made).
.PARAMETER RemovePlugin
  With -Uninstall: also delete WebView2.dll, but only if this script installed it (it writes the marker file
  WebView2.ccusagex-installed next to the DLL). A DLL without that marker is kept.
.PARAMETER WhatIf
  Dry run: prints what would happen and changes nothing (no download either).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\install-widget.ps1
  powershell -ExecutionPolicy Bypass -File scripts\install-widget.ps1 -StartWithWindows
  powershell -ExecutionPolicy Bypass -File scripts\install-widget.ps1 -Uninstall -RemovePlugin
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [ValidateRange(1, 65535)][int]$Port = 0,
  [switch]$StartWithWindows,
  [switch]$Uninstall,
  [switch]$RemovePlugin
)
#requires -Version 5.1

$ErrorActionPreference = 'Stop'
$SkinName   = 'ClaudePulse'
$PluginVer  = 'v1.0.0'
$PluginUrl  = "https://github.com/NSTechBytes/WebView2/releases/download/$PluginVer/WebView2_${PluginVer}_x64_x86_dll.zip"
$PluginSha  = 'f1b207eb61cfd3487cab39be3b176310af464104eb9f385357617b4fbf23e80c'   # SHA256 of the release zip
# SHA256 of WebView2.dll inside that zip, per folder in the zip (x32 = 32-bit Rainmeter, x64 = 64-bit Rainmeter)
$PluginDllSha = @{
  x32 = 'ccf7092f29e59a71539de877cf8a2243826c098d817bec6e376c5babdd930697'
  x64 = '978aa21805cc837f6ee5456822e49345ad3a1680dd2fd30462d48421037ff02f'
}
$ShortcutName = 'Rainmeter (CCUsageX widget).lnk'
$PluginMarkerName = 'WebView2.ccusagex-installed'

function Say($m)  { Write-Host $m }
function Warn($m) { Write-Host "WARNING: $m" -ForegroundColor Yellow }
function Fail($m, $code = 1) { Write-Host "ERROR: $m" -ForegroundColor Red; exit $code }
function Dry($m)  { Write-Host "[dry run] $m" -ForegroundColor Yellow }
# SHA256 of a file as lowercase hex. Plain .NET on purpose: Windows PowerShell 5.1 makes Get-FileHash return
# nothing under -WhatIf (its internal path lookup is suppressed).
function Get-Sha256([string]$Path) {
  $sha = [Security.Cryptography.SHA256]::Create()
  $fs  = [IO.File]::OpenRead($Path)
  try { ([BitConverter]::ToString($sha.ComputeHash($fs)) -replace '-', '').ToLowerInvariant() }
  finally { $fs.Dispose(); $sha.Dispose() }
}

# --- Windows + Rainmeter ----------------------------------------------------------------------------------------
if ($env:OS -ne 'Windows_NT') { Fail 'The Rainmeter widget is Windows only. On other systems open http://127.0.0.1:3020/widget.html in a browser.' }

$rmExe = $null
foreach ($p in @("$env:ProgramFiles\Rainmeter\Rainmeter.exe", "${env:ProgramFiles(x86)}\Rainmeter\Rainmeter.exe", "$env:LOCALAPPDATA\Programs\Rainmeter\Rainmeter.exe")) {
  if ($p -and (Test-Path -LiteralPath $p)) { $rmExe = $p; break }
}
if (-not $rmExe) {
  $running = Get-Process -Name Rainmeter -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($running -and $running.Path) { $rmExe = $running.Path }
}
if (-not $rmExe) {
  Write-Host 'Rainmeter is not installed.' -ForegroundColor Red
  Write-Host 'Download it from the official site, install it, then run this script again:  https://www.rainmeter.net'
  exit 2
}

$rmData = Join-Path $env:APPDATA 'Rainmeter'
$rmIni  = Join-Path $rmData 'Rainmeter.ini'
$skinsRoot = $null
if (Test-Path -LiteralPath $rmIni) {
  $m = Select-String -LiteralPath $rmIni -Pattern '^\s*SkinPath\s*=\s*(.+?)\s*$' | Select-Object -First 1
  if ($m) { $skinsRoot = $m.Matches[0].Groups[1].Value }
}
if (-not $skinsRoot) { $skinsRoot = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'Rainmeter\Skins' }
$skinsRoot = $skinsRoot.TrimEnd('\')
$pluginDir = Join-Path $rmData 'Plugins'
$pluginDll = Join-Path $pluginDir 'WebView2.dll'
$pluginMarker = Join-Path $pluginDir $PluginMarkerName
$skinDest  = Join-Path $skinsRoot $SkinName
$startupLnk = Join-Path ([Environment]::GetFolderPath('Startup')) $ShortcutName

function Invoke-Rainmeter([string[]]$bangArgs) {
  # Bangs go to the running Rainmeter; if none is running this starts it with the bang.
  & $rmExe @bangArgs
}

# --- Uninstall --------------------------------------------------------------------------------------------------
if ($Uninstall) {
  Say "Rainmeter:   $rmExe"
  if (Test-Path -LiteralPath $skinDest) {
    if ($PSCmdlet.ShouldProcess($skinDest, 'Deactivate and delete skin')) {
      if (Get-Process -Name Rainmeter -ErrorAction SilentlyContinue) {
        Invoke-Rainmeter @('!DeactivateConfig', $SkinName); Start-Sleep -Milliseconds 800
      }
      Remove-Item -LiteralPath $skinDest -Recurse -Force
      Say "Removed skin: $skinDest"
    } else { Dry "would deactivate and delete $skinDest" }
  } else { Say 'Skin not installed.' }
  if (Test-Path -LiteralPath $startupLnk) {
    if ($PSCmdlet.ShouldProcess($startupLnk, 'Delete Startup shortcut')) { Remove-Item -LiteralPath $startupLnk -Force; Say 'Removed Startup shortcut.' }
    else { Dry "would delete $startupLnk" }
  }
  if ($RemovePlugin) {
    if (-not (Test-Path -LiteralPath $pluginDll)) {
      Say 'Plugin:      WebView2.dll not present, nothing to remove.'
      if (Test-Path -LiteralPath $pluginMarker) {   # stale marker: the DLL it describes is gone
        if ($PSCmdlet.ShouldProcess($pluginMarker, 'Delete stale plugin marker')) { Remove-Item -LiteralPath $pluginMarker -Force }
        else { Dry "would delete stale marker $pluginMarker" }
      }
    } elseif (-not (Test-Path -LiteralPath $pluginMarker)) {
      Say "Plugin:      kept $pluginDll (this script did not install it, so it is left in place)."
    } elseif ($PSCmdlet.ShouldProcess($pluginDll, 'Delete WebView2 plugin installed by this script')) {
      try {
        Remove-Item -LiteralPath $pluginDll -Force
        Remove-Item -LiteralPath $pluginMarker -Force
        Say 'Removed WebView2 plugin (installed by this script).'
      }
      catch { Say 'Plugin is in use by Rainmeter. Quit Rainmeter and run again with -RemovePlugin to delete it.' }
    } else { Dry "would delete $pluginDll and $pluginMarker" }
  }
  Say 'Done. CCUsageX itself was not touched.'
  exit 0
}

# --- Install ----------------------------------------------------------------------------------------------------
$repoRoot = Split-Path -Parent $PSScriptRoot
$skinSrc  = Join-Path $repoRoot "integrations\rainmeter\$SkinName"
if (-not (Test-Path -LiteralPath (Join-Path $skinSrc "$SkinName.ini"))) { Fail "Skin source not found: $skinSrc" }

$arch = if ($rmExe -like '*Program Files (x86)*') { 'x32' } else { 'x64' }
Say "Rainmeter:   $rmExe"
Say "Skins:       $skinsRoot"
Say "Plugin:      WebView2 $PluginVer ($arch) -> $pluginDll"

# 1. plugin (an existing WebView2.dll is kept, never overwritten blindly)
if (Test-Path -LiteralPath $pluginDll) {
  $have = Get-Sha256 $pluginDll
  if ($have -eq $PluginDllSha[$arch]) { Say 'Plugin:      already installed, SHA256 matches the pinned DLL, keeping it.' }
  else { Warn "existing $pluginDll has SHA256 $have, expected $($PluginDllSha[$arch]) for WebView2 $PluginVer ($arch). Keeping it; delete it and run again to install the pinned file." }
} elseif ($PSCmdlet.ShouldProcess($pluginDll, "Download $PluginUrl, verify SHA256, install")) {
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ('ccux-widget-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    $zip = Join-Path $tmp 'plugin.zip'
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $PluginUrl -OutFile $zip -UseBasicParsing
    $got = Get-Sha256 $zip
    if ($got -ne $PluginSha) { Fail "Plugin checksum mismatch (expected $PluginSha, got $got). Nothing was installed." 3 }
    $out = Join-Path $tmp 'x'
    Expand-Archive -LiteralPath $zip -DestinationPath $out
    $dll = Join-Path $out "$arch\WebView2.dll"
    if (-not (Test-Path -LiteralPath $dll)) { Fail "Plugin archive has no $arch\WebView2.dll." 3 }
    $dllSha = Get-Sha256 $dll
    if ($dllSha -ne $PluginDllSha[$arch]) { Fail "Plugin DLL checksum mismatch in $arch (expected $($PluginDllSha[$arch]), got $dllSha). Nothing was installed." 3 }
    New-Item -ItemType Directory -Force -Path $pluginDir | Out-Null
    Copy-Item -LiteralPath $dll -Destination $pluginDll -Force
    Set-Content -LiteralPath $pluginMarker -Value "Installed by CCUsageX scripts/install-widget.ps1: WebView2 $PluginVer ($arch), SHA256 $dllSha" -Encoding ASCII
    Say 'Plugin:      downloaded, checksum OK, installed.'
  } finally { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
} else { Dry "would download $PluginUrl (sha256 $PluginSha) and install $arch\WebView2.dll" }

# 2. skin
if ($PSCmdlet.ShouldProcess($skinDest, 'Copy skin')) {
  New-Item -ItemType Directory -Force -Path $skinDest | Out-Null
  $destIni = Join-Path $skinDest "$SkinName.ini"
  $keepPort = $null
  if ($Port -eq 0 -and (Test-Path -LiteralPath $destIni)) {   # keep the port the user already chose
    $pm = Select-String -LiteralPath $destIni -Pattern '^\s*Port\s*=\s*(\d+)' | Select-Object -First 1
    if ($pm) { $keepPort = [int]$pm.Matches[0].Groups[1].Value }
  }
  Get-ChildItem -LiteralPath $skinSrc | Copy-Item -Destination $skinDest -Recurse -Force
  $usePort = if ($Port -gt 0) { $Port } else { $keepPort }
  if ($usePort) {
    $txt = [IO.File]::ReadAllText($destIni)
    $txt = [regex]::Replace($txt, '(?m)^Port=\d+', "Port=$usePort")
    [IO.File]::WriteAllText($destIni, $txt, (New-Object Text.UTF8Encoding($false)))
  }
  Say "Skin:        copied to $skinDest"
} else {
  $portNote = if ($Port -gt 0) { " and set Port=$Port" } else { '' }
  Dry "would copy $skinSrc to $skinDest$portNote"
}

# 3. Startup shortcut
if ($StartWithWindows) {
  if (Test-Path -LiteralPath $startupLnk) { Say 'Startup:     shortcut already present.' }
  elseif ($PSCmdlet.ShouldProcess($startupLnk, 'Create Startup shortcut to Rainmeter')) {
    $sh = New-Object -ComObject WScript.Shell
    $lnk = $sh.CreateShortcut($startupLnk)
    $lnk.TargetPath = $rmExe
    $lnk.WorkingDirectory = Split-Path -Parent $rmExe
    $lnk.Save()
    Say 'Startup:     Rainmeter will start at logon.'
  } else { Dry "would create $startupLnk" }
}

# 4. Rainmeter.ini position (first run only), then activate with Rainmeter's own bangs.
# Position keys documented for skin sections in Rainmeter.ini: https://docs.rainmeter.net/manual/settings/skin-sections/
# WindowX=12R = 12 px from the right edge of the primary screen; AnchorX=R = that point is the window's right edge;
# WindowY=12 = 12 px below the top. Result: top-right corner with a 12 px margin. Existing sections are never changed.
$firstRun = $true
if (Test-Path -LiteralPath $rmIni) { $firstRun = -not (Select-String -LiteralPath $rmIni -Pattern "^\[$SkinName\]" -Quiet) }
$placeBlock = "[$SkinName]`nAnchorX=R`nAnchorY=0`nWindowX=12R`nWindowY=12`n"
if ($firstRun) {
  if ($PSCmdlet.ShouldProcess($rmIni, "Add [$SkinName] top-right position (WindowX=12R, WindowY=12, AnchorX=R)")) {
    if (Test-Path -LiteralPath $rmIni) {
      $rmBytes = [IO.File]::ReadAllBytes($rmIni)
      $isUtf16 = $rmBytes.Length -ge 2 -and $rmBytes[0] -eq 0xFF -and $rmBytes[1] -eq 0xFE   # Rainmeter.ini is UTF-16 LE with BOM
      $rmEnc = if ($isUtf16) { [Text.Encoding]::Unicode } else { New-Object -TypeName Text.UTF8Encoding -ArgumentList $false }
      $sep = if ($rmBytes.Length -gt 0 -and -not $rmEnc.GetString($rmBytes).EndsWith("`n")) { "`n" } else { '' }
      [IO.File]::AppendAllText($rmIni, $sep + $placeBlock, $rmEnc)
    } else {
      New-Item -ItemType Directory -Force -Path $rmData | Out-Null
      [IO.File]::WriteAllText($rmIni, $placeBlock, [Text.Encoding]::Unicode)
    }
    Say "Position:    [$SkinName] added to Rainmeter.ini (top-right of the primary screen, 12 px margin)."
  } else { Dry "would add [$SkinName] WindowX=12R, WindowY=12, AnchorX=R to $rmIni" }
}
if ($PSCmdlet.ShouldProcess("$SkinName\$SkinName.ini", 'Activate with Rainmeter')) {
  Invoke-Rainmeter @('!ActivateConfig', $SkinName, "$SkinName.ini")
  # already active: ActivateConfig is a no-op then, so reload the new skin files in place (position is kept)
  if (-not $firstRun) { Invoke-Rainmeter @('!Refresh', $SkinName) }
  Say 'Activated.   Drag the widget to place it; Rainmeter remembers the spot.'
  Say 'Note:        start CCUsageX (node server.js) if it is not running; the widget connects by itself.'
} else {
  $where = if ($firstRun) { 'first run: position keys are added to Rainmeter.ini first' } else { 'existing position kept' }
  Dry "would run: Rainmeter.exe !ActivateConfig $SkinName $SkinName.ini ($where)"
}
