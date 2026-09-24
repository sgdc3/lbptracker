# Open an .als in Ableton Live, say what Live's own log says about loading it,
# optionally capture Live's window, then close Live.
#
#   powershell -File tools/open-in-live.ps1 -file song.als [-shot live.png] [-settle 8]
#
# Why this exists: Live 11 opens a set with members missing, fills them with
# defaults and writes NOTHING to its log -- sequencerdump's sets open that way
# with every clip gone. So "no exception" is necessary and not sufficient, and
# the screenshot is the other half. steering/ableton-interchange.md has what it
# showed and what it cannot show.
#
# ❗ It closes Live when it is done, and kills it if the close waits on a dialog,
# so it refuses to start while Live is running: a set open there with unsaved
# work would go with it.
# ⚠️ To see more than the Session view, ask for it in a debug copy of the set --
# the members are in steering/ableton-interchange.md, *How it was checked*.
# ❗ The capture is of Live's window alone (PrintWindow on its handle), never of
# the screen: a full-screen grab takes whatever else is open on the desktop.
# ⚠️ It sends no keys and no clicks. Tried: SendKeys and mouse_event from here
# both missed Live, and aiming synthetic clicks at a desktop somebody is using
# lands them in whatever is on top.
#
# LBP_LIVE_EXE and LBP_LIVE_LOG override the paths; the defaults are this
# machine's Live 11.3.43.

param([Parameter(Mandatory = $true)][string]$file, [string]$shot = "", [int]$settle = 8)

$exe = if ($env:LBP_LIVE_EXE) { $env:LBP_LIVE_EXE } else { "C:\ProgramData\Ableton\Live 11 Trial\Program\Ableton Live 11 Trial.exe" }
$log = if ($env:LBP_LIVE_LOG) { $env:LBP_LIVE_LOG } else { "$env:APPDATA\Ableton\Live 11.3.43\Preferences\Log.txt" }

if (Get-Process | Where-Object { $_.ProcessName -like 'Ableton Live*' }) {
  Write-Error "Live is already running; close it first (this script kills it when done)."
  exit 1
}

if (-not (Test-Path -LiteralPath $file)) {
  Write-Error "No such set: $file"
  exit 1
}
$file = (Resolve-Path -LiteralPath $file).Path
$before = (Get-Content $log).Count
Start-Process -FilePath $exe -ArgumentList "`"$file`"" | Out-Null

# Live writes this line once the command-line document is in, loaded or not.
$deadline = (Get-Date).AddSeconds(120)
$new = @()
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 2
  $new = Get-Content $log -Encoding UTF8 | Select-Object -Skip $before
  if ($new | Select-String 'Loading command-line document: done') { break }
}
$new | Select-String -Pattern 'Exception|Failed to load|Loading document|TryToLoadTemplate' | ForEach-Object { $_.Line }

if ($shot -ne "") {
  Start-Sleep -Seconds $settle
  Add-Type @"
using System; using System.Runtime.InteropServices;
public static class LiveWindow {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint f);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  public struct RECT { public int L, T, R, B; }
}
"@
  Add-Type -AssemblyName System.Drawing
  $proc = Get-Process | Where-Object { $_.ProcessName -like 'Ableton Live*' -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if ($proc) {
    $h = $proc.MainWindowHandle
    [LiveWindow]::ShowWindow($h, 3) | Out-Null   # maximised, so the capture is the whole UI
    Start-Sleep -Seconds 2
    $r = New-Object LiveWindow+RECT
    [LiveWindow]::GetWindowRect($h, [ref]$r) | Out-Null
    $bmp = New-Object System.Drawing.Bitmap ($r.R - $r.L), ($r.B - $r.T)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $dc = $g.GetHdc()
    [LiveWindow]::PrintWindow($h, $dc, 2) | Out-Null   # 2: PW_RENDERFULLCONTENT
    $g.ReleaseHdc($dc)
    $bmp.Save($shot, [System.Drawing.Imaging.ImageFormat]::Png)
    "captured '$($proc.MainWindowTitle)' to $shot"
  } else {
    "no Live window to capture"
  }
}

# Close it the way a user would, so Live does not greet the next run with a
# crash report (it did, after a kill); kill it only if it is still there after
# that. Then wait for it to be gone, so a second run straight after this one
# does not find it still exiting and refuse.
$live = Get-Process | Where-Object { $_.ProcessName -like 'Ableton*' }
$live | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { $_.CloseMainWindow() | Out-Null }
$live | Wait-Process -Timeout 20 -ErrorAction SilentlyContinue
$left = Get-Process | Where-Object { $_.ProcessName -like 'Ableton*' }
if ($left) {
  "Live did not close by itself (a dialog?); killing it"
  $left | Stop-Process -Force
  $left | Wait-Process -Timeout 30 -ErrorAction SilentlyContinue
}
