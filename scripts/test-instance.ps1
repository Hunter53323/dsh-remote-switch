# Starts a throwaway DSH instance for this plugin's verification suites, fully
# isolated from the machine's real instance.
#
# This script exists because the setup has three traps that each cost real time
# to rediscover (all three were hit while building this plugin):
#
#   1. The test profile's `cordis.patch.yml` is copied from the real profile, and
#      the real one pins the server to 0.0.0.0:3080 (so it is reachable on the
#      LAN). Starting with that copy fails with EADDRINUSE against the real
#      instance. It must be rewritten to `port: 0`.
#   2. `dsh plugin add` writes into the profile's node_modules. If that directory
#      is a junction onto the real profile's node_modules, pnpm writes *through*
#      it into the real installation — an interrupted run deleted the real
#      copy of this very plugin. So node_modules is built as a real directory of
#      per-package junctions, with this plugin's own junction pointed at the
#      working tree, and pnpm is never run.
#   3. A force-killed instance leaves `task-board/ledger-v2.lock` naming its dead
#      PID, and the next start refuses to boot. Clear the *test* home's lock.
#
# Usage:
#   pwsh -File scripts/test-instance.ps1 -Action setup     # stage the profile
#   pwsh -File scripts/test-instance.ps1 -Action start     # boot and print the URL
#   pwsh -File scripts/test-instance.ps1 -Action stop      # stop it
#   pwsh -File scripts/test-instance.ps1 -Action cleanup   # stop and delete
#
# `start` blocks, so run it as a background job and read its output for the
# token. The instance's DSH_HOME is printed first so the caller can export it for
# the suites (they read `$env:DSH_HOME` to find the harness home).

param(
  [Parameter(Mandatory = $true)][ValidateSet('setup', 'start', 'stop', 'cleanup')][string]$Action,
  [string]$TestRoot = 'E:\study\dshdev\.test',
  [string]$DevPlugin = 'E:\study\dshdev\dsh-remote-switch',
  [string]$LiveProfile = "$env:USERPROFILE\.dsh\profiles\web"
)

$ErrorActionPreference = 'Stop'
$home_ = Join-Path $TestRoot 'home'
$work = Join-Path $TestRoot 'work'
$profileDir = Join-Path $home_ 'profiles\web'

function Stop-TestInstance {
  # Kill the process that owns the listening port, not the shell: ending the
  # Kill the process that owns the listening port, not the shell: ending the
  # job/shell does not take the node child with it.
  #
  # Three sources, tried together because each catches what the others miss, and
  # ALL narrowly scoped — this must never be able to kill an unrelated instance
  # (the machine's real DSH most of all):
  #   1. the PID recorded at launch (the reliable handle: one `dsh web` opens
  #      several loopback sockets, so a port lookup alone leaves siblings behind);
  #   2. the PIDs netstat reports as listening on the test's recorded port;
  #   3. node processes whose command line names this test's DSH_HOME.
  # Source 3 contributes nothing in a locked-down shell (the CIM command-line
  # query is denied there), which is exactly why 1 and 2 exist. Falling back to
  # "kill any node process" would be a disaster and is deliberately not done.
  $killed = 0
  for ($round = 0; $round -lt 5; $round++) {
    $targets = @()

    $pidFile = Join-Path $TestRoot 'pid.txt'
    if (Test-Path $pidFile) {
      # `.Trim()` matters: `Set-Content` writes a trailing CRLF, and `^\d+$`
      # does not match through it — without the trim the recorded PID is
      # silently ignored and the instance is never found.
      $recorded = (Get-Content $pidFile -Raw -ErrorAction SilentlyContinue)
      if ($recorded -ne $null -and $recorded.Trim() -match '^\d+$') { $targets += [int]$recorded.Trim() }
    }

    $portFile = Join-Path $TestRoot 'port.txt'
    if (Test-Path $portFile) {
      $recordedPort = (Get-Content $portFile -Raw -ErrorAction SilentlyContinue)
      if ($recordedPort -ne $null -and $recordedPort.Trim() -match '^\d+$') {
        $targets += (netstat -ano |
          Select-String 'LISTENING' |
          Select-String ":$($recordedPort.Trim())\s" |
          ForEach-Object { ($_ -split '\s+')[-1] } |
          Where-Object { $_ -match '^\d+$' } |
          ForEach-Object { [int]$_ })
      }
    }

    foreach ($procId in @(Get-Process node -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)) {
      $cmdline = (Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -ErrorAction SilentlyContinue).CommandLine
      if ($cmdline -ne $null -and $cmdline.Contains($home_)) { $targets += $procId }
    }

    $targets = @($targets | Sort-Object -Unique | Where-Object { $_ -ne $PID })
    if ($targets.Count -eq 0) { break }
    foreach ($procId in $targets) {
      if (-not (Get-Process -Id $procId -ErrorAction SilentlyContinue)) { continue }
      Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
      Write-Host "stopped pid $procId"
      $killed++
    }
    Start-Sleep -Milliseconds 800
  }
  if ($killed -eq 0) { Write-Host 'no test instance was running' }
  Remove-Item (Join-Path $TestRoot 'pid.txt'), (Join-Path $TestRoot 'port.txt') -Force -ErrorAction SilentlyContinue
  $script:TestPort = $null
}

function Get-TestPort {
  if (Test-Path (Join-Path $TestRoot 'port.txt')) {
    $saved = Get-Content (Join-Path $TestRoot 'port.txt') -Raw
    if ($saved -ne $null -and $saved.Trim() -match '^\d+$') { return [int]$saved.Trim() }
  }
  return $null
}

$script:TestPort = Get-TestPort

switch ($Action) {
  'stop' {
    # No port gate: the recorded PID is the reliable handle, and the port file
    # may legitimately be missing if the instance never printed its launch line.
    Stop-TestInstance
  }

  'cleanup' {
    Stop-TestInstance
    if (Test-Path $TestRoot) {
      # Break junctions first: a plain recursive delete can otherwise follow one
      # into the real installation, and a plain delete of the workspace can
      # otherwise fail on a link it cannot traverse.
      Get-ChildItem $TestRoot -Recurse -Force -ErrorAction SilentlyContinue |
        Where-Object { $_.LinkType -eq 'Junction' } |
        ForEach-Object { cmd /c "rmdir `"$($_.FullName)`"" 2>&1 | Out-Null }
      cmd /c "rmdir /s /q `"$TestRoot`"" 2>&1 | Out-Null
      # The delete can be refused while a just-killed process releases its
      # working directory, so retry briefly rather than leaving the tree behind.
      for ($attempt = 0; $attempt -lt 6 -and (Test-Path $TestRoot); $attempt++) {
        Start-Sleep -Milliseconds 700
        cmd /c "rmdir /s /q `"$TestRoot`"" 2>&1 | Out-Null
      }
    }
    Write-Host "cleaned $TestRoot : $(Test-Path $TestRoot)"
  }

  'setup' {
    if (-not (Test-Path $LiveProfile)) { throw "live profile not found: $LiveProfile" }
    New-Item -ItemType Directory -Force $home_, $work, $profileDir | Out-Null

    # Config files come from the real profile so the test instance has the same
    # plugin set; node_modules does NOT (see trap 2 above).
    foreach ($file in @('cordis.yml', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml')) {
      $src = Join-Path $LiveProfile $file
      if (Test-Path $src) { Copy-Item $src (Join-Path $profileDir $file) -Force }
    }

    # Trap 1: never inherit the real profile's pinned port.
    @'
# Throwaway copy of the real profile's patch layer, for the isolated test
# instance only. The real profile pins 0.0.0.0:3080; this copy takes an
# OS-assigned port so the two can never collide. It stays on 0.0.0.0 rather than
# loopback because the remote-access plugin only issues pairing links when the
# server has a LAN base - bound to 127.0.0.1 alone it answers `lan-required`.
- id: webserver
  name: '@deepseek-ai/dsh-host-webserver'
  config:
    host: '0.0.0.0'
    port: 0
    compression: gzip
    compressionLevel: 1
    compressionThresholdBytes: 1024
'@ | Set-Content (Join-Path $profileDir 'cordis.patch.yml') -Encoding UTF8

    # Trap 2: a real directory of per-package junctions, so nothing this suite
    # does can ever write into the real installation.
    $testModules = Join-Path $profileDir 'node_modules'
    if (Test-Path $testModules) { cmd /c "rmdir /s /q `"$testModules`"" 2>&1 | Out-Null }
    New-Item -ItemType Directory -Force $testModules | Out-Null
    $liveModules = Join-Path $LiveProfile 'node_modules'
    $made = 0
    Get-ChildItem $liveModules -Force | ForEach-Object {
      if ($_.Name -in @('.bin', '.pnpm', '.modules.yaml', '.package-lock.json')) { return }
      cmd /c "mklink /J `"$(Join-Path $testModules $_.Name)`" `"$($_.FullName)`"" 2>&1 | Out-Null
      if ($LASTEXITCODE -eq 0) { $made++ }
    }
    # This plugin is the one package that must point at the working tree, not at
    # the installed copy.
    $pluginLink = Join-Path $testModules 'dsh-remote-switch'
    if (Test-Path $pluginLink) { cmd /c "rmdir `"$pluginLink`"" 2>&1 | Out-Null }
    cmd /c "mklink /J `"$pluginLink`" `"$DevPlugin`"" 2>&1 | Out-Null
    Write-Host "junctions: $made + dsh-remote-switch -> $DevPlugin"

    # Register the bundle so the profile actually loads it.
    $manifestPath = Join-Path $profileDir 'package.json'
    $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
    $bundles = @($manifest.dsh.profile.bundles)
    if ($bundles -notcontains 'dsh-remote-switch') { $bundles += 'dsh-remote-switch' }
    $manifest.dsh.profile.bundles = $bundles
    if (-not $manifest.dependencies.'dsh-remote-switch') {
      $manifest.dependencies | Add-Member -NotePropertyName 'dsh-remote-switch' -NotePropertyValue "file:$DevPlugin" -Force
    }
    $manifest | ConvertTo-Json -Depth 10 | Set-Content $manifestPath -Encoding UTF8

    Write-Host "test DSH_HOME: $home_"
  }

  'start' {
    if (-not (Test-Path $profileDir)) { throw "run -Action setup first" }
    # Trap 3: a stale lock from a force-killed instance blocks boot.
    Remove-Item (Join-Path $home_ 'task-board\ledger-v2.lock') -Force -ErrorAction SilentlyContinue
    $env:DSH_HOME = $home_
    Set-Location $work

    # The instance's PID is recorded at launch, not rediscovered later. A
    # running instance opens SEVERAL loopback sockets (its own port plus plugin
    # and IPC sockets on ephemeral ports), so finding it again by port leaves
    # the siblings behind — and in a locked-down shell the command-line lookup
    # that would catch them is unavailable. Recording the PID the moment it
    # exists is the only reliable handle.
    # `dsh` resolves to a shell shim (.cmd/.ps1), which `Start-Process` cannot
    # launch directly ("not a valid Win32 application"), so the real entry point
    # is located and run under node. `where` is tried first but not trusted
    # alone: a confined shell may answer nothing, and that must not read as
    # "dsh is not installed".
    $dshBin = $null
    $candidates = @()
    $located = (where.exe dsh 2>$null)
    if ($located) {
      foreach ($shim in $located) {
        $candidates += (Join-Path (Split-Path $shim.Trim() -Parent) 'node_modules\@deepseek-ai\dsh\lib\bin.js')
      }
    }
    $candidates += (Join-Path $env:APPDATA 'npm\node_modules\@deepseek-ai\dsh\lib\bin.js')
    $candidates += (Join-Path (Split-Path (Get-Command node).Source -Parent) 'node_modules\@deepseek-ai\dsh\lib\bin.js')
    foreach ($candidate in $candidates) {
      if (Test-Path $candidate) { $dshBin = $candidate; break }
    }
    if ($dshBin -eq $null) { throw 'could not resolve the dsh CLI entry point' }
    Write-Host "dsh: $dshBin"

    $stdout = Join-Path $TestRoot 'instance.out.log'
    $stderr = Join-Path $TestRoot 'instance.err.log'
    Remove-Item $stdout, $stderr -Force -ErrorAction SilentlyContinue
    Write-Host "DSH_HOME=$home_"
    # `--port 0` means the OS picks the port, so it is learned from the launch
    # line this loop is reading, and written where `stop`/`cleanup` can find it.
    $process = Start-Process -FilePath (Get-Command node).Source `
      -ArgumentList @($dshBin, '--profile', 'web', '--no-open', '--port', '0') `
      -WorkingDirectory $work -NoNewWindow -PassThru `
      -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    Set-Content (Join-Path $TestRoot 'pid.txt') $process.Id
    Write-Host "pid $($process.Id)"

    # Stream only NEW log bytes out (tracked by offset), so the caller can read
    # the launch token without the log being reprinted on every poll. The file is
    # opened with a SHARED handle because the instance still owns it for writing —
    # a plain read is refused with "being used by another process".
    $seen = @{ out = 0; err = 0 }
    $announced = $false
    $deadline = (Get-Date).AddSeconds(120)
    while ((Get-Date) -lt $deadline) {
      foreach ($entry in @(@{ key = 'out'; path = $stdout }, @{ key = 'err'; path = $stderr })) {
        $file = $entry.path
        if (-not (Test-Path $file)) { continue }
        $fresh = ''
        try {
          $stream = [System.IO.File]::Open($file, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
          try {
            $offset = $seen[$entry.key]
            if ($stream.Length -gt $offset) {
              $stream.Seek($offset, [System.IO.SeekOrigin]::Begin) | Out-Null
              $buffer = New-Object byte[] ($stream.Length - $offset)
              $read = $stream.Read($buffer, 0, $buffer.Length)
              $fresh = [System.Text.Encoding]::UTF8.GetString($buffer, 0, $read)
              $seen[$entry.key] = $offset + $read
            }
          } finally { $stream.Dispose() }
        } catch {
          # A transient sharing conflict just means the writer is mid-flush.
          $fresh = ''
        }
        foreach ($line in ($fresh -split "`r?`n")) {
          if ($line -ne '') { Write-Host $line }
        }
        if ($fresh -match '127\.0\.0\.1:(\d+)/\?token=') {
          Set-Content (Join-Path $TestRoot 'port.txt') $Matches[1]
          if (-not $announced) {
            $announced = $true
            Write-Host "test instance is up on port $($Matches[1])"
          }
        }
      }
      if ($process.HasExited) {
        Write-Host "instance exited with code $($process.ExitCode)"
        break
      }
      if ($announced) {
        # The instance is serving and its launch line has been emitted; there is
        # nothing left to report, so stop polling and just hold the process.
        Wait-Process -Id $process.Id -ErrorAction SilentlyContinue
        break
      }
      Start-Sleep -Milliseconds 400
    }
  }
}
