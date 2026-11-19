<#
  dsh-task-ask-notify - Windows toast + audio adapter.

  This script is spawned once per alert as a short-lived, detached child process by
  ../win.js. Everything it needs arrives in one base64(UTF-8 JSON) argument, so no
  value is ever interpolated into a command line and PowerShell 5.1 never has to
  guess a text encoding. The file itself is stored as UTF-8 with BOM for the same
  reason: Windows PowerShell reads a BOM-less .ps1 as ANSI and would mangle the
  comments below.

  Why Windows PowerShell 5.1 and not pwsh: the WinRT type projections
  (Windows.UI.Notifications.*, Windows.Data.Xml.Dom.*) load in the in-box 5.1
  engine but not in PowerShell 7 without extra modules. win.js therefore spawns
  %SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe explicitly.

  Exit codes (observed by win.js and surfaced in the plugin log):
     0  toast shown; audio played, skipped, or intentionally disabled
     2  payload could not be decoded or parsed
     3  toast failed
     4  audio failed
    12  toast and audio both failed

  A toast that fails because the AUMID is not registered reports success at the
  WinRT layer, so exit code 0 is not proof the notification was visible. See the
  README section "Troubleshooting" for the AUMID self-check.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string] $PayloadB64
)

$ErrorActionPreference = 'Stop'

# --- decode the single argument ------------------------------------------------
try {
  $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($PayloadB64))
  $alert = ConvertFrom-Json -InputObject $json
}
catch {
  [Console]::Error.WriteLine("payload decode failed: $($_.Exception.Message)")
  exit 2
}

if ($null -eq $alert) {
  [Console]::Error.WriteLine('payload decode failed: no JSON document')
  exit 2
}

$title     = if ($null -eq $alert.title) { '' } else { [string] $alert.title }
$body      = if ($null -eq $alert.body) { '' } else { [string] $alert.body }
$aumid     = if ($null -eq $alert.aumid) { '' } else { [string] $alert.aumid }
$audioPath = if ($null -eq $alert.audioPath) { '' } else { [string] $alert.audioPath }
$volume    = if ($null -eq $alert.volume) { 1.0 } else { [double] $alert.volume }
$duration  = if ($null -eq $alert.durationMs) { 0 } else { [int] $alert.durationMs }
$maxWait   = if ($null -eq $alert.maxDurationMs) { 10000 } else { [int] $alert.maxDurationMs }
$wantToast = if ($null -eq $alert.notify) { $true } else { [bool] $alert.notify }
$wantAudio = if ($null -eq $alert.audio) { $true } else { [bool] $alert.audio }
# <audio silent="true"/> keeps the OS chime out of the way of the plugin's own WAV.
$silent    = if ($null -eq $alert.silent) { $true } else { [bool] $alert.silent }

if ($volume -lt 0.0) { $volume = 0.0 }
if ($volume -gt 1.0) { $volume = 1.0 }
if ($maxWait -lt 500) { $maxWait = 500 }

$toastOk = $true
$audioOk = $true

# --- 1) Windows 11 toast ------------------------------------------------------
if ($wantToast) {
  try {
    if ($aumid -eq '') { throw 'no AUMID in payload' }

    [void] [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
    [void] [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]

    $template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent(
      [Windows.UI.Notifications.ToastTemplateType]::ToastText02)
    $document = New-Object Windows.Data.Xml.Dom.XmlDocument
    $document.LoadXml($template.GetXml())

    # CreateTextNode + AppendChild, never string concatenation: model-authored text
    # and workspace names may contain &, <, > or quotes.
    $nodes = $document.GetElementsByTagName('text')
    [void] $nodes.Item(0).AppendChild($document.CreateTextNode($title))
    [void] $nodes.Item(1).AppendChild($document.CreateTextNode($body))

    if ($silent) {
      $audioElement = $document.CreateElement('audio')
      $audioElement.SetAttribute('silent', 'true')
      [void] $document.DocumentElement.AppendChild($audioElement)
    }

    $toast = [Windows.UI.Notifications.ToastNotification]::new($document)
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($aumid).Show($toast)
    # Hold a reference until the process exits: a collected ToastNotification can be
    # torn down while Windows is still animating it.
    [GC]::KeepAlive($toast)
  }
  catch {
    $toastOk = $false
    [Console]::Error.WriteLine("toast failed: $($_.Exception.Message)")
  }
}

# --- 2) audio -----------------------------------------------------------------
$playable = $wantAudio -and $audioPath -ne '' -and (Test-Path -LiteralPath $audioPath -PathType Leaf)

if ($wantAudio -and -not $playable) {
  [Console]::Error.WriteLine("audio skipped: no readable file at '$audioPath'")
}

if ($playable) {
  # Two engines, tried in order. Either path is bounded by maxDurationMs, so a
  # stuck decoder can never leave the process (and the file handle) behind.
  if ($audioPath -match '^[a-zA-Z][a-zA-Z0-9+.\-]*://') {
    $audioUri = [uri] $audioPath
  }
  else {
    $audioUri = [uri] ([System.IO.Path]::GetFullPath($audioPath))
  }

  $played = $false
  $lastError = ''

  # 1) WinRT Windows.Media.Playback.MediaPlayer. It drives Media Foundation
  #    directly, which every Windows 10/11 install has, and it does not need
  #    Windows Media Player.
  #
  #    The WPF System.Windows.Media.MediaPlayer this script used to call is *not*
  #    equivalent: on a machine where Windows Media Player has been removed
  #    (stripped images, debloat tools, some updates) it opens the file, raises no
  #    error, never reports a duration, and renders pure silence — so the adapter
  #    exited 0 having played nothing, and the only symptom was a notification with
  #    no sound. Measured on exactly that machine with the endpoint's peak meter:
  #    the WPF player held it at 0.0000, this one drives it to 0.36.
  try {
    [void] [Windows.Media.Playback.MediaPlayer, Windows.Media.Playback, ContentType = WindowsRuntime]
    [void] [Windows.Media.Core.MediaSource, Windows.Media.Core, ContentType = WindowsRuntime]

    $player = New-Object Windows.Media.Playback.MediaPlayer
    $player.Source = [Windows.Media.Core.MediaSource]::CreateFromUri($audioUri)
    $player.Volume = $volume
    $player.Play()

    $deadline = (Get-Date).AddMilliseconds($maxWait)
    $sawPlaying = $false
    while ((Get-Date) -lt $deadline) {
      $session = $player.PlaybackSession
      if ($session.PlaybackState -eq 'Playing') { $sawPlaying = $true }
      $length = $session.NaturalDuration.TotalMilliseconds
      $position = $session.Position.TotalMilliseconds
      # A short clip can finish between two polls; a stalled one never leaves
      # Playing, and the deadline above is what stops it.
      if ($sawPlaying -and $session.PlaybackState -ne 'Playing') { break }
      if ($length -gt 0 -and $position -ge ($length - 50)) { break }
      Start-Sleep -Milliseconds 50
    }

    $reached = $sawPlaying -or $player.PlaybackSession.Position.TotalMilliseconds -gt 0
    $player.Pause()
    $player.Dispose()
    if (-not $reached) { throw 'playback never started' }
    $played = $true
  }
  catch {
    $lastError = "winrt media player: $($_.Exception.Message)"
  }

  # 2) System.Media.SoundPlayer: winmm waveOut, independent of the media stack.
  #    It has no volume control, so it is the last resort, not the first choice.
  if (-not $played) {
    try {
      $sound = New-Object System.Media.SoundPlayer
      $sound.SoundLocation = $audioPath
      $sound.Load()
      $sound.Play()

      $wait = if ($duration -gt 0) { $duration + 250 } else { 3000 }
      if ($wait -gt $maxWait) { $wait = $maxWait }
      if ($wait -lt 0) { $wait = 0 }

      Start-Sleep -Milliseconds $wait
      $sound.Stop()
      $played = $true
    }
    catch {
      $lastError = "$lastError; sound player: $($_.Exception.Message)"
    }
  }

  if (-not $played) {
    $audioOk = $false
    [Console]::Error.WriteLine("audio failed: $lastError")
  }
}

# --- 3) report ----------------------------------------------------------------
if (-not $toastOk -and -not $audioOk) { exit 12 }
if (-not $toastOk) { exit 3 }
if (-not $audioOk) { exit 4 }
exit 0
