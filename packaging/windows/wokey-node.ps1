$ErrorActionPreference = "Stop"

$TaskName = "WokeyProviderNode"
$DefaultAppRoot = Join-Path $env:LOCALAPPDATA "WokeyProviderNode"
$AppRoot = if ($env:PROVIDER_NODE_APP_ROOT) { $env:PROVIDER_NODE_APP_ROOT } else { $DefaultAppRoot }
$AppDir = if ($env:PROVIDER_NODE_APP_DIR) { $env:PROVIDER_NODE_APP_DIR } else { Join-Path $AppRoot "app" }
$BinDir = Join-Path $AppRoot "bin"
$LogDir = Join-Path $AppRoot "logs"
$PidFile = Join-Path $AppRoot "provider-node.pid"
$DefaultDataDir = Join-Path $env:APPDATA "Wokey Provider Node"
$DataDir = if ($env:PROVIDER_NODE_DATA_DIR) { $env:PROVIDER_NODE_DATA_DIR } else { $DefaultDataDir }
$DefaultConfigPath = Join-Path $DataDir "provider-node.json"
$DefaultConsoleHost = "127.0.0.1"
$DefaultConsolePort = "16888"
$DefaultDownloadBaseUrl = "https://github.com/focuxdot/wokey-provider-node/releases/latest/download"
$DownloadBaseUrl = if ($env:WOKEY_PROVIDER_NODE_BASE_URL) { $env:WOKEY_PROVIDER_NODE_BASE_URL.TrimEnd("/") } else { $DefaultDownloadBaseUrl }
$ScriptPath = $MyInvocation.MyCommand.Path
$CliPath = Join-Path $BinDir "provider-node-cli.mjs"
# Records the Node interpreter `wokey-node restart` resolved, so the scheduled
# task's `serve` (which may run with a PATH that excludes version managers like
# nvm-windows/fnm/volta) can reuse the very same binary.
$NodeHintFile = Join-Path $DataDir "node-path"
$ConsoleReadyTimeoutSeconds = if ($env:PROVIDER_CONSOLE_READY_TIMEOUT) { [int]$env:PROVIDER_CONSOLE_READY_TIMEOUT } else { 15 }

function Get-NodeBin {
  if ($env:PROVIDER_NODE_NODE -and (Test-Path $env:PROVIDER_NODE_NODE)) {
    return $env:PROVIDER_NODE_NODE
  }

  # Prefer the interpreter a prior `restart` recorded, so the background task
  # finds a Node that only exists on the user's interactive PATH.
  if (Test-Path $NodeHintFile) {
    $hint = (Get-Content $NodeHintFile -ErrorAction SilentlyContinue | Select-Object -First 1)
    if ($hint -and (Test-Path $hint)) {
      return $hint
    }
  }

  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) {
    return $cmd.Source
  }

  return $null
}

# Persist the interpreter Ensure-Node just resolved ($script:NodeBin) so the
# scheduled task reuses it instead of failing to find Node.
function Save-NodeHint {
  if (-not $script:NodeBin) { return }
  try {
    New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
    Set-Content -Path $NodeHintFile -Value $script:NodeBin -Encoding ascii
  } catch {}
}

# Poll the console until it answers or the timeout elapses.
function Wait-ForConsole {
  $url = (Get-ConsoleUrl) + "api/status"
  $deadline = (Get-Date).AddSeconds($ConsoleReadyTimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $resp = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2
      if ([int]$resp.StatusCode -lt 500) { return $true }
    } catch {}
    Start-Sleep -Milliseconds 400
  }
  return $false
}

# Print a short tail of the service error log to explain a failed start.
function Show-RecentErrors {
  $errLog = Join-Path $LogDir "provider-node.err.log"
  if (Test-Path $errLog) {
    Write-Host "--- $errLog (last 20 lines) ---"
    Get-Content $errLog -Tail 20
  } else {
    Write-Host "(no error log at $errLog yet)"
  }
}

function Ensure-Node {
  $script:NodeBin = Get-NodeBin
  if (-not $script:NodeBin) {
    throw "Provider Node requires Node.js 20 or newer. Install Node.js, then run: wokey-node restart"
  }

  $major = & $script:NodeBin -p "Number(process.versions.node.split('.')[0])"
  if ([int]$major -lt 20) {
    $version = & $script:NodeBin --version
    throw "Provider Node requires Node.js 20 or newer. Found $version."
  }
}

function Set-ProviderEnv {
  New-Item -ItemType Directory -Force -Path $DataDir, $LogDir | Out-Null
  if (-not $env:PROVIDER_CONFIG_PATH) {
    $env:PROVIDER_CONFIG_PATH = $DefaultConfigPath
  }
  if (-not $env:PROVIDER_CONSOLE_HOST) {
    $env:PROVIDER_CONSOLE_HOST = $DefaultConsoleHost
  }
  if (-not $env:PROVIDER_CONSOLE_PORT) {
    $env:PROVIDER_CONSOLE_PORT = $DefaultConsolePort
  }
  if (-not $env:NODE_USE_ENV_PROXY) {
    $env:NODE_USE_ENV_PROXY = "1"
  }
  if (-not $env:LOG_LEVEL) {
    $env:LOG_LEVEL = "info"
  }
}

function Get-ConsoleUrl {
  Set-ProviderEnv
  return "http://$($env:PROVIDER_CONSOLE_HOST):$($env:PROVIDER_CONSOLE_PORT)/"
}

function Invoke-Server {
  Ensure-Node
  Set-ProviderEnv
  New-Item -ItemType Directory -Force -Path $AppRoot, $LogDir | Out-Null
  Set-Content -Path $PidFile -Value $PID -Encoding ascii
  Set-Location $AppDir
  $outLog = Join-Path $LogDir "provider-node.out.log"
  $errLog = Join-Path $LogDir "provider-node.err.log"
  Remove-Item $outLog, $errLog -Force -ErrorAction SilentlyContinue
  $cmdLine = "`"$script:NodeBin`" dist/provider-node/server.js >> `"$outLog`" 2>> `"$errLog`""
  & $env:ComSpec /d /s /c $cmdLine
}

function Stop-Node {
  if (Test-Path $PidFile) {
    $pidText = (Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
    if ($pidText) {
      $nodePid = [int]$pidText
      $proc = Get-Process -Id $nodePid -ErrorAction SilentlyContinue
      if ($proc) {
        Stop-Process -Id $nodePid -Force -ErrorAction SilentlyContinue
      }
    }
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
  }
}

function Start-Daemon {
  Ensure-Node
  Set-ProviderEnv
  Stop-Node
  New-Item -ItemType Directory -Force -Path $AppRoot, $LogDir | Out-Null

  $outLog = Join-Path $LogDir "provider-node.out.log"
  $errLog = Join-Path $LogDir "provider-node.err.log"
  $process = Start-Process `
    -FilePath $script:NodeBin `
    -ArgumentList @("dist/provider-node/server.js") `
    -WorkingDirectory $AppDir `
    -WindowStyle Hidden `
    -RedirectStandardOutput $outLog `
    -RedirectStandardError $errLog `
    -PassThru

  Set-Content -Path $PidFile -Value $process.Id -Encoding ascii
  Save-NodeHint
  if (Wait-ForConsole) {
    Write-Host "Wokey Provider Node started."
    Write-Host "Console: $(Get-ConsoleUrl)"
  } else {
    Write-Warning "Wokey Provider Node was launched but its console did not come up at $(Get-ConsoleUrl) within ${ConsoleReadyTimeoutSeconds}s."
    Show-RecentErrors
    Write-Host "Fix the cause above, then run: wokey-node restart"
    exit 75
  }
}

function Install-Service {
  Ensure-Node
  Set-ProviderEnv
  $psExe = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
  $args = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$ScriptPath`" serve"
  $action = New-ScheduledTaskAction -Execute $psExe -Argument $args
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description "Wokey Provider Node" -Force | Out-Null
  Write-Host "Wokey Provider Node scheduled task installed."
}

function Restart-Service {
  Install-Service
  Save-NodeHint
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Stop-Node
  Start-ScheduledTask -TaskName $TaskName
  if (Wait-ForConsole) {
    Write-Host "Wokey Provider Node started."
    Write-Host "Console: $(Get-ConsoleUrl)"
  } else {
    Write-Warning "Wokey Provider Node was started but its console did not come up at $(Get-ConsoleUrl) within ${ConsoleReadyTimeoutSeconds}s."
    Show-RecentErrors
    Write-Host "Fix the cause above, then run: wokey-node restart"
    exit 75
  }
}

function Update-Node {
  $tempDir = Join-Path ([IO.Path]::GetTempPath()) ("wokey-provider-node-update-" + [Guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Force -Path $tempDir | Out-Null
  try {
    $installer = Join-Path $tempDir "install.ps1"
    $cacheBust = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    $url = "$DownloadBaseUrl/install.ps1?update=$cacheBust"
    Write-Host "Downloading Wokey Provider Node installer from $url"
    Invoke-WebRequest -Uri $url -OutFile $installer -UseBasicParsing
    $env:WOKEY_PROVIDER_NODE_BASE_URL = $DownloadBaseUrl
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer
    if ($LASTEXITCODE -ne 0) {
      exit $LASTEXITCODE
    }
  } finally {
    Remove-Item $tempDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Uninstall-Service {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Stop-Node
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Wokey Provider Node scheduled task removed."
  Write-Host "User data was kept at: $DataDir"
}

function Show-Status {
  Ensure-Node
  Set-ProviderEnv
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($task) {
    Write-Host "Scheduled task: $($task.State)"
  } else {
    Write-Host "Scheduled task: not installed"
  }

  if (Test-Path $PidFile) {
    $pidText = (Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
    $proc = if ($pidText) { Get-Process -Id ([int]$pidText) -ErrorAction SilentlyContinue } else { $null }
    if ($proc) {
      Write-Host "Process: running pid=$pidText"
    } else {
      Write-Host "Process: not running"
    }
  } else {
    Write-Host "Process: not running"
  }

  Write-Host "Console: $(Get-ConsoleUrl)"
  Invoke-Cli @("api-status")
}

function Show-Logs {
  Set-ProviderEnv
  $outLog = Join-Path $LogDir "provider-node.out.log"
  $errLog = Join-Path $LogDir "provider-node.err.log"
  if (Test-Path $errLog) {
    Write-Host "== stderr =="
    Get-Content $errLog -Tail 80
  }
  if (Test-Path $outLog) {
    Write-Host "== stdout =="
    Get-Content $outLog -Tail 80
  }
}

function Open-Console {
  Start-Process (Get-ConsoleUrl)
  Write-Host "Console: $(Get-ConsoleUrl)"
}

function Invoke-Cli {
  param([string[]]$CliArgs)
  Ensure-Node
  Set-ProviderEnv
  $env:PROVIDER_NODE_CLI_BASE_URL = if ($env:PROVIDER_NODE_CLI_BASE_URL) {
    $env:PROVIDER_NODE_CLI_BASE_URL
  } else {
    "http://$($env:PROVIDER_CONSOLE_HOST):$($env:PROVIDER_CONSOLE_PORT)"
  }
  & $script:NodeBin $CliPath @CliArgs
}

function Show-Doctor {
  Ensure-Node
  Set-ProviderEnv
  Write-Host "node=$script:NodeBin"
  Write-Host "app=$AppDir"
  Write-Host "bin=$BinDir"
  Write-Host "data=$DataDir"
  Write-Host "config=$($env:PROVIDER_CONFIG_PATH)"
  Write-Host "pid=$PidFile"
  Write-Host "console=$(Get-ConsoleUrl)"
}

$Command = if ($args.Count -gt 0) { $args[0] } else { "menu" }
$Rest = @()
if ($args.Count -gt 1) {
  $Rest = $args[1..($args.Count - 1)]
}

switch ($Command) {
  "serve" { Invoke-Server }
  "start-daemon" { Start-Daemon }
  "install-service" { Install-Service }
  "uninstall-service" { Uninstall-Service }
  "start" { Restart-Service }
  "restart" { Restart-Service }
  "update" { Update-Node }
  "stop" { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue; Stop-Node; Write-Host "Wokey Provider Node stopped." }
  "status" { Show-Status }
  "logs" { Show-Logs }
  "open" { Open-Console }
  "menu" { Invoke-Cli @("menu") }
  "auth" { Invoke-Cli $Rest }
  "version" {
    Ensure-Node
    Set-Location $AppDir
    & $script:NodeBin -e "const pkg=require('./package.json'); console.log(pkg.version)"
  }
  "doctor" { Show-Doctor }
  default { Invoke-Cli $args }
}
