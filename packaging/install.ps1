$ErrorActionPreference = "Stop"

# Older Windows PowerShell (5.1 on Win7/8/Server) negotiates TLS 1.0 by default,
# which nodejs.org and github.com reject — every HTTPS call below would fail with
# "Could not create SSL/TLS secure channel". Opt into TLS 1.2 (and 1.3 where the
# enum exists) up front. Two separate try blocks so a missing Tls13 enum on old
# .NET cannot discard the Tls12 setting.
try {
  [Net.ServicePointManager]::SecurityProtocol = `
    [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch {}
try {
  [Net.ServicePointManager]::SecurityProtocol = `
    [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls13
} catch {}

$Version = if ($env:WOKEY_PROVIDER_NODE_VERSION) { $env:WOKEY_PROVIDER_NODE_VERSION } else { "0.1.38" }
$PackageRevision = if ($env:WOKEY_PROVIDER_NODE_PACKAGE_REVISION) { $env:WOKEY_PROVIDER_NODE_PACKAGE_REVISION } else { $Version }
$DefaultBaseUrl = "https://github.com/focuxdot/wokey-provider-node/releases/download/v$Version"
$BaseUrl = if ($env:WOKEY_PROVIDER_NODE_BASE_URL) { $env:WOKEY_PROVIDER_NODE_BASE_URL.TrimEnd("/") } else { $DefaultBaseUrl }
$AppRoot = Join-Path $env:LOCALAPPDATA "WokeyProviderNode"
$AppDir = Join-Path $AppRoot "app"
$BinDir = Join-Path $AppRoot "bin"

# Identity the release checksums.txt signature must chain to. Releases are
# signed keyless by the GitHub Actions release workflow (cosign + Fulcio).
$CosignIdentityRegexp = if ($env:WOKEY_PROVIDER_NODE_COSIGN_IDENTITY) { $env:WOKEY_PROVIDER_NODE_COSIGN_IDENTITY } else { "^https://github.com/focuxdot/wokey-provider-node/\.github/workflows/release\.yml@refs/(tags/v.*|heads/main)$" }
$CosignOidcIssuer = if ($env:WOKEY_PROVIDER_NODE_COSIGN_ISSUER) { $env:WOKEY_PROVIDER_NODE_COSIGN_ISSUER } else { "https://token.actions.githubusercontent.com" }
# By default, install remains convenient for provider-owned machines that do not
# have cosign preinstalled. SHA-256 artifact verification is always required.
# Set WOKEY_PROVIDER_NODE_REQUIRE_SIGNATURE=1 to require cosign provenance.
$RequireSignature = if ($env:WOKEY_PROVIDER_NODE_REQUIRE_SIGNATURE) {
  $env:WOKEY_PROVIDER_NODE_REQUIRE_SIGNATURE -in @("1", "true", "TRUE", "yes", "YES")
} else {
  $false
}

function Fail($Message) {
  throw "wokey provider node installer: $Message"
}

# Append the default Node.js locations and any registry PATH entries the current
# process is missing. After winget/MSI installs Node, the running PowerShell
# session still has the old PATH, so a freshly installed `node` is invisible until
# we do this. We append rather than replace so session-only PATH entries (and the
# already-expanded system paths) are preserved.
function Refresh-Path {
  $additions = @()
  if ($env:ProgramFiles) { $additions += (Join-Path $env:ProgramFiles "nodejs") }
  if (${env:ProgramFiles(x86)}) { $additions += (Join-Path ${env:ProgramFiles(x86)} "nodejs") }
  foreach ($scope in @("Machine", "User")) {
    $value = [Environment]::GetEnvironmentVariable("Path", $scope)
    if ($value) { $additions += ($value -split ";" | Where-Object { $_ }) }
  }
  $existing = $env:Path -split ";"
  foreach ($entry in $additions) {
    # Skip unexpanded REG_EXPAND_SZ literals (e.g. "%SystemRoot%\system32") — the
    # process PATH already carries their expanded forms, so appending the literal
    # would only add an inert, non-resolving entry.
    if ($entry -and ($entry -notlike "*%*") -and ($existing -notcontains $entry)) {
      $env:Path = "$env:Path;$entry"
      $existing += $entry
    }
  }
}

function Test-NodeOk {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { return $false }
  try {
    $major = [int](& $node.Source -p "Number(process.versions.node.split('.')[0])")
  } catch {
    return $false
  }
  return $major -ge 20
}

# Download and silently install the latest Node.js LTS MSI from nodejs.org. This
# is the universal fallback: it works on Windows versions without winget and on
# x64 / arm64 / 32-bit hosts alike.
function Install-NodeFromOfficialMsi {
  $arch = "x64"
  if (-not [Environment]::Is64BitOperatingSystem) {
    $arch = "x86"
  } elseif ($env:PROCESSOR_ARCHITECTURE -eq "ARM64" -or $env:PROCESSOR_ARCHITEW6432 -eq "ARM64") {
    $arch = "arm64"
  }

  Write-Host "Resolving the latest Node.js LTS release from nodejs.org"
  $version = $null
  try {
    $index = Invoke-RestMethod -Uri "https://nodejs.org/dist/index.json"
    $version = ($index | Where-Object { $_.lts } | Select-Object -First 1).version
  } catch {
    $version = $null
  }
  if (-not $version) {
    Fail "could not resolve the latest Node.js LTS version from nodejs.org. Install Node.js 20+ from https://nodejs.org, then rerun this installer."
  }

  $msiName = "node-$version-$arch.msi"
  $msiPath = Join-Path ([IO.Path]::GetTempPath()) $msiName
  Download-File "https://nodejs.org/dist/$version/$msiName" $msiPath
  Write-Host "Installing $msiName silently"
  $proc = Start-Process msiexec.exe -Wait -PassThru -ArgumentList "/i `"$msiPath`" /quiet /norestart"
  Remove-Item $msiPath -Force -ErrorAction SilentlyContinue
  if ($proc.ExitCode -ne 0 -and $proc.ExitCode -ne 3010) {
    Fail "Node.js MSI installer exited with code $($proc.ExitCode)"
  }
  Refresh-Path
}

function Install-Node {
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if ($winget) {
    Write-Host "Installing Node.js LTS via winget"
    try {
      & $winget.Source install --exact --id OpenJS.NodeJS.LTS `
        --silent --accept-source-agreements --accept-package-agreements
    } catch {
      Write-Warning "winget install raised an error: $_"
    }
    Refresh-Path
    if (Test-NodeOk) { return }
    Write-Warning "winget did not yield Node.js 20+; falling back to the official MSI."
  }
  Install-NodeFromOfficialMsi
}

function Ensure-Node {
  if (-not (Test-NodeOk)) {
    $existing = Get-Command node -ErrorAction SilentlyContinue
    if ($existing) {
      Write-Host "Node.js $(& $existing.Source --version) is too old (Node.js 20+ required); installing a newer Node.js"
    } else {
      Write-Host "Node.js 20+ was not found; installing it automatically"
    }
    # Pipe to Out-Null: Install-Node invokes winget/msiexec, whose stdout would
    # otherwise leak into this function's output stream and corrupt the npm path
    # returned below (the caller does `& $npmPath ci ...`).
    Install-Node | Out-Null
    if (-not (Test-NodeOk)) {
      Fail "automatic Node.js installation did not complete. Install Node.js 20+ from https://nodejs.org (or run: winget install OpenJS.NodeJS.LTS), open a new PowerShell window, then rerun this installer."
    }
    Write-Host "Using Node.js $(node --version)"
  }

  $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if (-not $npm) {
    $npm = Get-Command npm -ErrorAction SilentlyContinue
  }
  if (-not $npm) {
    Fail "npm is required. Install Node.js with npm, then rerun this installer."
  }

  return $npm.Source
}

function Add-UserPath($PathToAdd) {
  $current = [Environment]::GetEnvironmentVariable("Path", "User")
  $parts = @()
  if ($current) {
    $parts = $current -split ";" | Where-Object { $_ }
  }
  $exists = $false
  foreach ($part in $parts) {
    if ($part.TrimEnd("\") -ieq $PathToAdd.TrimEnd("\")) {
      $exists = $true
    }
  }
  if (-not $exists) {
    $newPath = if ($current) { "$current;$PathToAdd" } else { $PathToAdd }
    [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
  }
  if (($env:Path -split ";") -notcontains $PathToAdd) {
    $env:Path = "$env:Path;$PathToAdd"
  }
}

function Find-PayloadRoot($ExtractDir) {
  $expected = Join-Path $ExtractDir "WokeyProviderNode-win-x64-$Version"
  if (Test-Path (Join-Path $expected "app")) {
    return $expected
  }

  $child = Get-ChildItem $ExtractDir -Directory | Where-Object { Test-Path (Join-Path $_.FullName "app") } | Select-Object -First 1
  if ($child) {
    return $child.FullName
  }

  Fail "downloaded package has an unexpected layout"
}

function Download-File($Url, $OutFile) {
  Write-Host "Downloading $Url"
  Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing
}

function Read-Checksums($Path) {
  $map = @{}
  foreach ($line in Get-Content $Path) {
    $trimmed = $line.Trim()
    if (-not $trimmed) { continue }
    $parts = $trimmed -split "\s+", 2
    if ($parts.Length -eq 2) {
      $map[$parts[1].Trim()] = $parts[0].Trim().ToLowerInvariant()
    }
  }
  return $map
}

function Verify-Artifact($Path, $ChecksumsPath) {
  $name = Split-Path $Path -Leaf
  $checksums = Read-Checksums $ChecksumsPath
  if (-not $checksums.ContainsKey($name)) {
    Fail "checksums.txt does not contain $name"
  }
  $actual = (Get-FileHash -Algorithm SHA256 -Path $Path).Hash.ToLowerInvariant()
  if ($actual -ne $checksums[$name]) {
    Fail "checksum mismatch for $name"
  }
  Write-Host "Verified $name"
}

# Verify the cosign signature over checksums.txt. The per-artifact SHA-256 check
# proves integrity; this proves authenticity — that the checksums were produced
# by the official release workflow, not an attacker who swapped both files.
function Verify-ChecksumsSignature($ChecksumsPath, $TempDir) {
  $sig = Join-Path $TempDir "checksums.txt.sig"
  $cert = Join-Path $TempDir "checksums.txt.pem"

  $downloaded = $true
  try {
    Download-File "$BaseUrl/checksums.txt.sig?v=$PackageRevision" $sig
    Download-File "$BaseUrl/checksums.txt.pem?v=$PackageRevision" $cert
  } catch {
    $downloaded = $false
  }

  if (-not $downloaded) {
    if ($RequireSignature) {
      Fail "release signature (checksums.txt.sig/.pem) not found"
    }
    Write-Warning "release signature not found; continuing with SHA-256 checksum verification only."
    return
  }

  $cosign = Get-Command cosign -ErrorAction SilentlyContinue
  if (-not $cosign) {
    if ($RequireSignature) {
      Fail "cosign is required for release signature verification but was not found"
    }
    Write-Warning "cosign not installed; skipped optional release provenance verification."
    Write-Host "The artifact SHA-256 will still be verified against checksums.txt."
    Write-Host "For strict provenance verification, install cosign and rerun with WOKEY_PROVIDER_NODE_REQUIRE_SIGNATURE=1."
    Write-Host "Manual verification command:"
    Write-Host "  cosign verify-blob --certificate checksums.txt.pem --signature checksums.txt.sig --certificate-identity-regexp '$CosignIdentityRegexp' --certificate-oidc-issuer '$CosignOidcIssuer' checksums.txt"
    return
  }

  try {
    & $cosign.Source verify-blob `
      --certificate $cert `
      --signature $sig `
      --certificate-identity-regexp $CosignIdentityRegexp `
      --certificate-oidc-issuer $CosignOidcIssuer `
      $ChecksumsPath
  } catch {
    Fail "checksums.txt signature verification failed: $_"
  }
  if ($LASTEXITCODE -ne 0) {
    Fail "checksums.txt signature verification failed"
  }
  Write-Host "Verified checksums.txt signature (cosign keyless)."
}

$npmPath = Ensure-Node

New-Item -ItemType Directory -Force -Path $AppRoot | Out-Null

$oldWrapper = Join-Path $BinDir "wokey-node.ps1"
if (Test-Path $oldWrapper) {
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File $oldWrapper stop | Out-Null
}

$tempDir = Join-Path ([IO.Path]::GetTempPath()) ("wokey-provider-node-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $tempDir | Out-Null

try {
  $zipName = "WokeyProviderNode-win-x64-$Version.zip"
  $zipPath = Join-Path $tempDir $zipName
  $checksumsPath = Join-Path $tempDir "checksums.txt"
  Download-File "$BaseUrl/checksums.txt?v=$PackageRevision" $checksumsPath
  Verify-ChecksumsSignature $checksumsPath $tempDir
  Download-File "$BaseUrl/$zipName?v=$PackageRevision" $zipPath
  Verify-Artifact $zipPath $checksumsPath

  Expand-Archive -Path $zipPath -DestinationPath $tempDir -Force
  $payloadRoot = Find-PayloadRoot $tempDir

  Remove-Item $AppDir, $BinDir -Recurse -Force -ErrorAction SilentlyContinue
  Copy-Item (Join-Path $payloadRoot "app") $AppDir -Recurse -Force
  Copy-Item (Join-Path $payloadRoot "bin") $BinDir -Recurse -Force

  Write-Host "Installing production dependencies"
  Push-Location $AppDir
  & $npmPath ci --omit=dev --ignore-scripts --no-audit --no-fund
  Pop-Location

  Add-UserPath $BinDir

  $wrapper = Join-Path $BinDir "wokey-node.ps1"
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File $wrapper install-service
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File $wrapper restart
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File $wrapper status

  Write-Host "Installed Wokey Provider Node $Version for Windows."
  Write-Host "Run: wokey-node"
} finally {
  Remove-Item $tempDir -Recurse -Force -ErrorAction SilentlyContinue
}
