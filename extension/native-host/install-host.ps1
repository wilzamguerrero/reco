param(
  [string]$ExtensionId
)

$ErrorActionPreference = "Stop"

function Find-RecoExtensionId {
  $roots = @(
    (Join-Path $env:LOCALAPPDATA "Google\Chrome\User Data"),
    (Join-Path $env:LOCALAPPDATA "Microsoft\Edge\User Data")
  )
  foreach ($root in $roots) {
    if (-not (Test-Path $root)) { continue }
    $prefFiles = Get-ChildItem -Path $root -Filter "Preferences" -Recurse -Depth 2 -ErrorAction SilentlyContinue
    foreach ($pf in $prefFiles) {
      try {
        $json = Get-Content -Path $pf.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
        $settings = $json.extensions.settings
        if ($null -eq $settings) { continue }
        foreach ($prop in $settings.PSObject.Properties) {
          $manifest = $prop.Value.manifest
          if ($manifest -and $manifest.name -like "RECO*") {
            return $prop.Name
          }
        }
      } catch {
        # ignorar perfiles bloqueados o corruptos
      }
    }
  }
  return $null
}

if (-not $ExtensionId) {
  $detected = Find-RecoExtensionId
  if ($detected) {
    Write-Host ""
    Write-Host "Se detecto el ID de RECO automaticamente: $detected" -ForegroundColor Green
    $ExtensionId = $detected
  } else {
    Write-Host ""
    Write-Host "RECO - Instalador de dictado para barra de direcciones y apps de escritorio" -ForegroundColor Cyan
    Write-Host "Copia el ID de la extension que aparece en chrome://extensions (o en la pestana Dictado de RECO)."
    $ExtensionId = (Read-Host "ID de la extension").Trim()
  }
}

if (-not $ExtensionId -or $ExtensionId -notmatch "^[a-p]{32}$") {
  Write-Host "ID invalido. Debe tener 32 letras minusculas (ej. abcdef...)." -ForegroundColor Red
  exit 1
}

$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$cmdPath = Join-Path $dir "reco-host.cmd"
$manifestPath = Join-Path $dir "com.reco.typer.json"

$manifest = @{
  name = "com.reco.typer"
  description = "RECO Desktop & Omnibox Cursor Typer"
  path = $cmdPath
  type = "stdio"
  allowed_origins = @("chrome-extension://$ExtensionId/")
} | ConvertTo-Json -Depth 4

[System.IO.File]::WriteAllText($manifestPath, $manifest, [System.Text.UTF8Encoding]::new($false))

$regPaths = @(
  "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.reco.typer",
  "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.reco.typer"
)

foreach ($reg in $regPaths) {
  New-Item -Path $reg -Force | Out-Null
  Set-ItemProperty -Path $reg -Name "(Default)" -Value $manifestPath
}

Write-Host ""
Write-Host "Listo! RECO ya puede escribir en la barra de direcciones de Chrome y en cualquier app de Windows." -ForegroundColor Green
Write-Host "Manifiesto: $manifestPath"
