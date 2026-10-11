<#
.SYNOPSIS
  Launcher for the local CCUsageX dashboard (works in pwsh 7 and Windows PowerShell 5.1).

.DESCRIPTION
  start    Start server.js hidden in the background (unless this app already serves the port),
           then open the dashboard in its own Edge app window (no tabs / address bar).
  stop     Stop the server recorded in state\server.pid (only after verifying it is this app's server.js).
  status   Print running/stopped, PID, URL and request/prompt counts.
  restart  stop + start.

.PARAMETER NoOpen
  Do not open a window after starting.

.PARAMETER CloseWindow
  With stop: also close the Edge app window that uses this project's edge-profile.

.PARAMETER Popup
  Show a message box on failure (used by the hidden double-click launcher, where no console is visible).
#>
[CmdletBinding()]
param(
    [ValidateSet('start', 'stop', 'status', 'restart')]
    [string]$Action = 'start',
    [switch]$NoOpen,
    [switch]$CloseWindow,
    [switch]$Popup
)

$ErrorActionPreference = 'Stop'

$Root      = $PSScriptRoot
$ServerJs  = Join-Path $Root 'server.js'
$StateDir  = Join-Path $Root 'state'
$LogDir    = Join-Path $Root 'logs'
$PidFile   = Join-Path $StateDir 'server.pid'
$EdgeProf  = Join-Path $StateDir 'edge-profile'
$OutLog    = Join-Path $LogDir 'server.out.log'
$ErrLog    = Join-Path $LogDir 'server.err.log'

# Port: config.json "port" (default 3020)
$Port = 3020
try {
    $cfg = Get-Content -LiteralPath (Join-Path $Root 'config.json') -Raw | ConvertFrom-Json
    if ($cfg.port) { $Port = [int]$cfg.port }
} catch { }
$Url = 'http://127.0.0.1:{0}/' -f $Port

function Fail([string]$msg, [int]$code = 1) {
    Write-Host "ERROR: $msg" -ForegroundColor Red
    if ($Popup) {
        try {
            Add-Type -AssemblyName System.Windows.Forms
            [void][System.Windows.Forms.MessageBox]::Show($msg, 'CCUsageX', 'OK', 'Error')
        } catch { }
    }
    exit $code
}

function Get-AppStatus {
    # Returns the /api/status object if THIS app answers on the port, else $null.
    try {
        $s = Invoke-RestMethod -Uri ($Url + 'api/status') -TimeoutSec 3 -ErrorAction Stop
        if ($s -and ($s.PSObject.Properties.Name -contains 'pricedModels') -and ($s.PSObject.Properties.Name -contains 'projectsDir')) {
            return $s
        }
    } catch { }
    return $null
}

function Test-PortInUse {
    $c = New-Object System.Net.Sockets.TcpClient
    try {
        $iar = $c.BeginConnect('127.0.0.1', $Port, $null, $null)
        if ($iar.AsyncWaitHandle.WaitOne(1500) -and $c.Connected) { return $true }
        return $false
    } catch { return $false } finally { $c.Close() }
}

function Get-CmdLine([int]$ProcId) {
    try { return (Get-CimInstance Win32_Process -Filter "ProcessId=$ProcId").CommandLine } catch { return $null }
}

function Test-IsOurServer([int]$ProcId) {
    $cl = Get-CmdLine $ProcId
    if (-not $cl) { return $false }
    return ($cl -like '*server.js*') -and ($cl.IndexOf($Root, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)
}

function Get-ListenerPid {
    try {
        $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Select-Object -First 1
        if ($c) { return [int]$c.OwningProcess }
    } catch { }
    return $null
}

function Get-RecordedPid {
    if (-not (Test-Path -LiteralPath $PidFile)) { return $null }
    $t = (Get-Content -LiteralPath $PidFile -Raw).Trim()
    $n = 0
    if ([int]::TryParse($t, [ref]$n)) { return $n }
    return $null
}

# The PID of our running server (verified), or $null.
function Get-ServerPid {
    $p = Get-RecordedPid
    if ($p -and (Get-Process -Id $p -ErrorAction SilentlyContinue) -and (Test-IsOurServer $p)) { return $p }
    # pid file missing/stale: maybe started by hand -> look at the port listener
    if (Get-AppStatus) {
        $lp = Get-ListenerPid
        if ($lp -and (Test-IsOurServer $lp)) { return $lp }
    }
    return $null
}

function Find-Edge {
    $cands = @()
    if (${env:ProgramFiles(x86)}) { $cands += (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe') }
    if ($env:ProgramFiles)        { $cands += (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe') }
    foreach ($c in $cands) { if (Test-Path -LiteralPath $c) { return $c } }
    $cmd = Get-Command msedge.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return $null
}

# Browser (main) processes of the Edge instance that uses this project's edge-profile.
function Get-EdgeAppProcesses {
    $res = @()
    try {
        $all = Get-CimInstance Win32_Process -Filter "Name='msedge.exe'"
        foreach ($p in $all) {
            $cl = $p.CommandLine
            if ($cl -and ($cl.IndexOf($EdgeProf, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) -and ($cl -notlike '*--type=*')) {
                $gp = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
                if ($gp) { $res += $gp }
            }
        }
    } catch { }
    return $res
}

function Show-ExistingWindow {
    # If our Edge app window already exists, bring it to the front and return $true.
    $procs = @(Get-EdgeAppProcesses | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero })
    if ($procs.Count -eq 0) { return $false }
    try {
        if (-not ('CCU.Win' -as [type])) {
            Add-Type -Namespace CCU -Name Win -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int n);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool IsIconic(System.IntPtr h);
'@
        }
        $h = $procs[0].MainWindowHandle
        if ([CCU.Win]::IsIconic($h)) { [void][CCU.Win]::ShowWindow($h, 9) }
        [void][CCU.Win]::SetForegroundWindow($h)
    } catch { }
    return $true
}

function Open-Dashboard {
    if (Show-ExistingWindow) { Write-Host 'Dashboard window already open - brought to front.'; return }
    $edge = Find-Edge
    if ($edge) {
        New-Item -ItemType Directory -Force -Path $EdgeProf | Out-Null
        $edgeArgs = @(
            ('--app={0}' -f $Url),
            ('--user-data-dir="{0}"' -f $EdgeProf),
            '--window-size=1600,1000',
            '--no-first-run',
            '--no-default-browser-check'
        )
        Start-Process -FilePath $edge -ArgumentList $edgeArgs | Out-Null
        Write-Host "Opened dashboard in Edge app window: $Url"
    } else {
        Write-Host 'Edge not found - opening in the default browser.' -ForegroundColor Yellow
        Start-Process $Url | Out-Null
    }
}

function Find-Node {
    $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $p = 'C:\Program Files\nodejs\node.exe'
    if (Test-Path -LiteralPath $p) { return $p }
    return $null
}

function Do-Start {
    $s = Get-AppStatus
    if ($s) {
        $sp = Get-ServerPid
        if ($sp -and ((Get-RecordedPid) -ne $sp)) {
            New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
            Set-Content -LiteralPath $PidFile -Value $sp -Encoding ASCII
        }
        Write-Host "Already running (reusing server) at $Url  PID=$sp"
    } else {
        if (Test-PortInUse) {
            Fail "Port $Port on 127.0.0.1 is already in use by another program (not this dashboard). Nothing was killed. Free the port or change `"port`" in config.json, then try again." 2
        }
        if (-not (Test-Path -LiteralPath $ServerJs)) { Fail "server.js not found at $ServerJs" }
        $node = Find-Node
        if (-not $node) { Fail 'Node.js (node.exe) not found. Install Node 18+ or add it to PATH.' }

        New-Item -ItemType Directory -Force -Path $StateDir, $LogDir | Out-Null
        $proc = Start-Process -FilePath $node `
            -ArgumentList @(('"{0}"' -f $ServerJs), '--port', "$Port") `
            -WorkingDirectory $Root -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput $OutLog -RedirectStandardError $ErrLog
        Set-Content -LiteralPath $PidFile -Value $proc.Id -Encoding ASCII

        $deadline = (Get-Date).AddSeconds(20)
        $ok = $false
        while ((Get-Date) -lt $deadline) {
            if ($proc.HasExited) { break }
            if (Get-AppStatus) { $ok = $true; break }
            Start-Sleep -Milliseconds 250
        }
        if (-not $ok) {
            $detail = ''
            if (Test-Path -LiteralPath $ErrLog) { $detail = (Get-Content -LiteralPath $ErrLog -Tail 8 -ErrorAction SilentlyContinue) -join "`n" }
            if (-not $proc.HasExited) { try { Stop-Process -Id $proc.Id -Force } catch { } }
            Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
            Fail "Server did not respond within 20 s. See $ErrLog`n$detail"
        }
        Write-Host "Started server (PID $($proc.Id)) at $Url"
    }
    if (-not $NoOpen) { Open-Dashboard }
}

function Do-Stop {
    $p = Get-ServerPid
    if ($p) {
        try { Stop-Process -Id $p -Force -ErrorAction Stop; Write-Host "Stopped server (PID $p)." }
        catch { Fail "Could not stop PID ${p}: $($_.Exception.Message)" }
        # wait briefly for the port to be released
        $d = (Get-Date).AddSeconds(5)
        while ((Get-Date) -lt $d -and (Test-PortInUse)) { Start-Sleep -Milliseconds 200 }
    } else {
        $rp = Get-RecordedPid
        if ($rp -and (Get-Process -Id $rp -ErrorAction SilentlyContinue)) {
            Write-Host "PID $rp from server.pid is not this app's server.js - not touching it." -ForegroundColor Yellow
        } else {
            Write-Host 'Server is not running.'
        }
        if ((Test-PortInUse) -and -not (Get-AppStatus)) {
            Write-Host "Note: port $Port is held by another program (left alone)." -ForegroundColor Yellow
        }
    }
    Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
    if ($CloseWindow) {
        # Graceful WM_CLOSE to the app window (Process.CloseMainWindow() returns false for Edge app windows).
        try {
            if (-not ('CCU.Msg' -as [type])) {
                Add-Type -Namespace CCU -Name Msg -MemberDefinition '[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool PostMessage(System.IntPtr h, uint m, System.IntPtr w, System.IntPtr l);'
            }
            foreach ($g in (Get-EdgeAppProcesses)) {
                if ($g.MainWindowHandle -ne [IntPtr]::Zero) { [void][CCU.Msg]::PostMessage($g.MainWindowHandle, 0x10, [IntPtr]::Zero, [IntPtr]::Zero) }
            }
        } catch { }
    }
}

function Do-Status {
    $s = Get-AppStatus
    if ($s) {
        $sp = Get-ServerPid
        Write-Host 'Status:   running'
        Write-Host "PID:      $sp"
        Write-Host "URL:      $Url"
        Write-Host "Requests: $($s.requests)"
        Write-Host "Prompts:  $($s.prompts)"
        Write-Host "Since:    $($s.startDate)   Files tracked: $($s.filesTracked)"
        if ($s.lastError) { Write-Host "Last scan error: $($s.lastError)" -ForegroundColor Yellow }
        return 0
    }
    Write-Host 'Status:   stopped'
    Write-Host "URL:      $Url"
    if (Test-PortInUse) { Write-Host "Note: port $Port is in use by another program." -ForegroundColor Yellow }
    return 3
}

switch ($Action) {
    'start'   { Do-Start }
    'stop'    { Do-Stop }
    'status'  { $rc = Do-Status; exit $rc }
    'restart' { Do-Stop; Do-Start }
}
exit 0
