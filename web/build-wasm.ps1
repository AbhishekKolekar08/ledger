$ErrorActionPreference = "Stop"
$webRoot = $PSScriptRoot
$crateRoot = Split-Path -Parent $webRoot

Push-Location $crateRoot
try {
    cargo build --release --target wasm32-unknown-unknown --lib
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    $wasmDirectory = Join-Path $webRoot "wasm"
    New-Item -ItemType Directory -Force -Path $wasmDirectory | Out-Null
    Copy-Item (Join-Path $crateRoot "target\wasm32-unknown-unknown\release\budget_tool.wasm") (Join-Path $wasmDirectory "budget_tool.wasm") -Force
} finally {
    Pop-Location
}