/**
 * Screen-capture backend for the `screenshot` tool: captures the whole
 * (virtual) screen, one window, or an absolute screen region and returns the
 * PNG bytes. Windows captures through PowerShell + System.Drawing
 * (CopyFromScreen for screen/region, PrintWindow with a GetWindowRect
 * fallback for windows); macOS and Linux use their built-in CLI captures.
 * The capture function is swappable through {@link internals} so tests run on
 * any host.
 * @module @deepseek-ai/dsh-vision-qwen/capture
 */

import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** What the `screenshot` tool asks for. */
export interface CaptureRequest {
  /** What to capture: the whole virtual screen, or a single window. */
  target: 'screen' | 'window'
  /** Window to capture when {@link CaptureRequest.target} is `window`: a process name or title substring (Windows) or a CGWindow id (macOS). */
  window?: string
  /** Absolute virtual-screen region `{x, y, width, height}` in pixels; overrides {@link CaptureRequest.target}. */
  region?: { x: number; y: number; width: number; height: number }
}

const CAPTURE_TIMEOUT_MS = 30_000

/** One platform's capture command: executable, fixed args, and the output-file arg. */
interface CaptureCommand {
  command: string
  args: string[]
  outArg: string
}

/** Substitute a single-quoted placeholder, doubling embedded quotes for PowerShell. */
function psQuoted(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'"
}

/**
 * The PowerShell one-shot that captures screen / window / region. Placeholders
 * `<REGION>` / `<WINDOW>` / `<OUT>` are substituted before execution; empty
 * REGION and WINDOW select the whole virtual screen.
 */
function buildWindowsScript(request: CaptureRequest, outPath: string): string {
  const region = request.region === undefined
    ? ''
    : [request.region.x, request.region.y, request.region.width, request.region.height].join(',')
  const windowQuery = request.target === 'window' ? request.window ?? '' : ''
  return `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class DshCapture {
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
}
"@
function Save-Bitmap([System.Drawing.Bitmap]$bmp, [string]$path) {
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
}
if (@REGION@ -ne '') {
  $parts = @REGION@.Split(',')
  $rx = [int]$parts[0]; $ry = [int]$parts[1]; $rw = [int]$parts[2]; $rh = [int]$parts[3]
  $bmp = New-Object System.Drawing.Bitmap($rw, $rh)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($rx, $ry, 0, 0, (New-Object System.Drawing.Size($rw, $rh)))
  $g.Dispose()
  Save-Bitmap $bmp @OUTPATH@
  $bmp.Dispose()
} elseif (@WINDOWQUERY@ -ne '') {
  $query = @WINDOWQUERY@
  $win = $null
  $byName = @(Get-Process -Name $query -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 })
  if ($byName.Count -gt 0) { $win = $byName[0] } else {
    $byTitle = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like "*$query*" })
    if ($byTitle.Count -gt 0) { $win = $byTitle[0] }
  }
  if ($null -eq $win) { throw "screenshot: no window matches $query" }
  $hwnd = $win.MainWindowHandle
  $rect = New-Object DshCapture+RECT
  [DshCapture]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
  $w = $rect.Right - $rect.Left
  $h = $rect.Bottom - $rect.Top
  if ($w -le 0 -or $h -le 0) { throw 'screenshot: window has no visible rect' }
  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $hdc = $g.GetHdc()
  $ok = [DshCapture]::PrintWindow($hwnd, $hdc, 2)
  $g.ReleaseHdc($hdc)
  $g.Dispose()
  if (-not $ok) {
    $g2 = [System.Drawing.Graphics]::FromImage($bmp)
    $g2.CopyFromScreen($rect.Left, $rect.Top, 0, 0, (New-Object System.Drawing.Size($w, $h)))
    $g2.Dispose()
  }
  Save-Bitmap $bmp @OUTPATH@
  $bmp.Dispose()
} else {
  $x = [DshCapture]::GetSystemMetrics(76)
  $y = [DshCapture]::GetSystemMetrics(77)
  $w = [DshCapture]::GetSystemMetrics(78)
  $h = [DshCapture]::GetSystemMetrics(79)
  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size($w, $h)))
  $g.Dispose()
  Save-Bitmap $bmp @OUTPATH@
  $bmp.Dispose()
}
`.replaceAll('@REGION@', psQuoted(region))
    .replaceAll('@WINDOWQUERY@', psQuoted(windowQuery))
    .replaceAll('@OUTPATH@', psQuoted(outPath))
}

/** Build the platform capture command; throws a descriptive error when the platform is unsupported. */
function buildCommand(request: CaptureRequest, outPath: string): CaptureCommand {
  const region = request.region
  if (region !== undefined) {
    if (![region.x, region.y, region.width, region.height].every(Number.isFinite)) {
      throw new Error('screenshot: region must be {x, y, width, height} numbers')
    }
    if (region.width <= 0 || region.height <= 0) {
      throw new Error('screenshot: region width and height must be positive')
    }
  }
  if (request.target === 'window' && (request.window ?? '').trim() === '') {
    throw new Error('screenshot: target=window requires a window name or id')
  }
  switch (process.platform) {
    case 'win32':
      return { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', buildWindowsScript(request, outPath)], outArg: outPath }
    case 'darwin': {
      if (region !== undefined) {
        return { command: 'screencapture', args: ['-x', `-R${region.x},${region.y},${region.width},${region.height}`], outArg: outPath }
      }
      if (request.target === 'window') {
        return { command: 'screencapture', args: ['-x', `-l${String(request.window).trim()}`], outArg: outPath }
      }
      return { command: 'screencapture', args: ['-x'], outArg: outPath }
    }
    case 'linux': {
      if (region !== undefined) {
        return {
          command: 'import',
          args: ['-window', 'root', '-crop', `${region.width}x${region.height}+${region.x}+${region.y}`],
          outArg: outPath,
        }
      }
      return { command: 'import', args: ['-window', 'root'], outArg: outPath }
    }
    default:
      throw new Error(`screenshot: screen capture is not supported on ${process.platform}`)
  }
}

/** Run one capture command and return the PNG bytes. */
async function runCapture(request: CaptureRequest, signal: AbortSignal | undefined): Promise<Buffer> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-screenshot-'))
  const outPath = join(dir, 'capture.png')
  try {
    const capture = buildCommand(request, outPath)
    await execFileAsync(capture.command, [...capture.args, capture.outArg], {
      windowsHide: true,
      timeout: CAPTURE_TIMEOUT_MS,
      signal,
      maxBuffer: 1 << 20,
    })
    return readFileSync(outPath)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Capture the screen / window / region as PNG bytes. The swappable hook keeps
 * the tool host-agnostic in tests; production always calls the real backend.
 */
export const internals: { capture: (request: CaptureRequest, signal: AbortSignal | undefined) => Promise<Buffer> } = {
  capture: runCapture,
}

/** Default export for tsdown's entry bundling. */
export default internals.capture
