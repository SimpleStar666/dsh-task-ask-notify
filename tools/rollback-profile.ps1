<#
  rollback-profile.ps1 - restore a DSH profile manifest from a timestamped backup.

  Changing a profile's `package.json` or `cordis.patch.yml` is the one operation
  that can stop DSH from starting, and the Agent tools live in the same process,
  so self-recovery may be unavailable. Keep this script reachable *before*
  installing or removing a bundle: it is plain PowerShell and depends on nothing
  from DSH.

  It looks for `<file>.bak-<tag>-<timestamp>` siblings, restores the newest pair
  of a tag, and first copies the files it is about to overwrite to a fresh backup
  so a wrong rollback is itself reversible.

  Usage:
    # see what is available
    .\rollback-profile.ps1 -ProfileDir <path-to-profile> -List

    # restore the newest backups of a tag
    .\rollback-profile.ps1 -ProfileDir <path-to-profile> -Tag my-plugin

  Example tag convention when backing up by hand:
    $ts = Get-Date -Format yyyyMMdd-HHmmss
    Copy-Item "$ProfileDir\package.json"     "$ProfileDir\package.json.bak-my-plugin-$ts"
    Copy-Item "$ProfileDir\cordis.patch.yml" "$ProfileDir\cordis.patch.yml.bak-my-plugin-$ts"
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string] $ProfileDir,

  [string] $Tag,

  [switch] $List
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $ProfileDir -PathType Container)) {
  Write-Error "not a directory: $ProfileDir"
  exit 2
}

$targets = @('package.json', 'cordis.patch.yml')

function Get-BackupGroups {
  $groups = @{}
  foreach ($target in $targets) {
    $pattern = if ([string]::IsNullOrWhiteSpace($Tag)) { "$target.bak-*" } else { "$target.bak-$Tag-*" }
    foreach ($file in Get-ChildItem -LiteralPath $ProfileDir -Filter $pattern -File -ErrorAction SilentlyContinue) {
      # <target>.bak-<tag>-<timestamp>  ->  tag may itself contain dashes, so the
      # timestamp is taken as the final dash-separated field.
      $suffix = $file.Name.Substring("$target.bak-".Length)
      $stamp = ($suffix -split '-')[-1]
      $key = "$target|$stamp"
      if (-not $groups.ContainsKey($key)) {
        $groups[$key] = [pscustomobject]@{ Target = $target; Stamp = $stamp; File = $file.FullName }
      }
    }
  }
  $groups.Values | Sort-Object -Property Stamp -Descending
}

$groups = @(Get-BackupGroups)

if ($groups.Count -eq 0) {
  Write-Host "no backups found in $ProfileDir"
  exit 1
}

if ($List) {
  $groups | Format-Table -AutoSize Target, Stamp, File
  exit 0
}

# Restore the newest complete pair: a missing half means that stamp is skipped.
$stamps = $groups | Select-Object -ExpandProperty Stamp -Unique
$chosen = $null
foreach ($stamp in $stamps) {
  $pair = @{}
  foreach ($target in $targets) {
    $match = $groups | Where-Object { $_.Target -eq $target -and $_.Stamp -eq $stamp } | Select-Object -First 1
    if ($null -ne $match) { $pair[$target] = $match.File }
  }
  if ($pair.Count -eq $targets.Count) { $chosen = $pair; break }
}

if ($null -eq $chosen) {
  Write-Error "no timestamp has backups for all of: $($targets -join ', ')"
  exit 1
}

$rollbackStamp = Get-Date -Format yyyyMMdd-HHmmss
foreach ($target in $targets) {
  $live = Join-Path $ProfileDir $target
  if (Test-Path -LiteralPath $live) {
    Copy-Item -LiteralPath $live -Destination "$live.bak-before-rollback-$rollbackStamp" -Force
  }
  Copy-Item -LiteralPath $chosen[$target] -Destination $live -Force
  Write-Host "restored $target <- $(Split-Path -Leaf $chosen[$target])"
}

Write-Host ''
Write-Host "The files that were replaced were saved as *.bak-before-rollback-$rollbackStamp."
Write-Host 'Restart DSH for the restored composition to take effect.'
