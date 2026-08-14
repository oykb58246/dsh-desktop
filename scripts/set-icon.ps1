param(
  [Parameter(Mandatory=$true)][string]$ExePath,
  [Parameter(Mandatory=$true)][string]$IcoPath
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class ResWriter {
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern IntPtr BeginUpdateResource(string pFileName, bool bDeleteExistingResources);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool UpdateResource(IntPtr hUpdate, IntPtr lpType, IntPtr lpName, ushort wLanguage, byte[] lpData, uint cbData);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool EndUpdateResource(IntPtr hUpdate, bool fDiscard);
}
"@

$bytes = [System.IO.File]::ReadAllBytes($IcoPath)
if ($bytes.Length -lt 22) { throw 'ico too small' }
$count = [BitConverter]::ToUInt16($bytes, 4)
$entries = @()
$pos = 6
for ($i = 0; $i -lt $count; $i++) {
  $w = $bytes[$pos]; if ($w -eq 0) { $w = 256 }
  $h = $bytes[$pos+1]; if ($h -eq 0) { $h = 256 }
  $size = [BitConverter]::ToUInt32($bytes, $pos+8)
  $off = [BitConverter]::ToUInt32($bytes, $pos+12)
  $entries += [PSCustomObject]@{ W=$w; H=$h; Size=$size; Off=$off }
  $pos += 16
}

# Build GRPICONDIR: header + GRPICONDIRENTRY per image
$grp = New-Object System.IO.MemoryStream
$grp.Write($bytes, 0, 6)
$ids = @()
for ($i = 0; $i -lt $count; $i++) {
  $e = $entries[$i]
  $bw = New-Object byte[] 1; $bw[0] = $(if ($e.W -eq 256) { 0 } else { $e.W })
  $bh = New-Object byte[] 1; $bh[0] = $(if ($e.H -eq 256) { 0 } else { $e.H })
  $b0 = New-Object byte[] 1
  $bplanes = [BitConverter]::GetBytes([uint16]1)
  $bbits = [BitConverter]::GetBytes([uint16]32)
  $bsize = [BitConverter]::GetBytes([uint32]$e.Size)
  $bid = [BitConverter]::GetBytes([uint16]($i+1))
  $grp.Write($bw, 0, 1); $grp.Write($bh, 0, 1); $grp.Write($b0, 0, 1); $grp.Write($b0, 0, 1)
  $grp.Write($bplanes, 0, 2); $grp.Write($bbits, 0, 2); $grp.Write($bsize, 0, 4); $grp.Write($bid, 0, 2)
  $ids += ($i+1)
}
$grpData = $grp.ToArray()
$grp.Dispose()

$h = [ResWriter]::BeginUpdateResource($ExePath, $true)
if ($h -eq [IntPtr]::Zero) { throw ('BeginUpdateResource failed: ' + [Runtime.InteropServices.Marshal]::GetLastWin32Error()) }
try {
  # write group icon (id 1) and each image (ids 1..N)
  $ok = [ResWriter]::UpdateResource($h, [IntPtr]14, [IntPtr]1, 0, $grpData, [uint32]$grpData.Length)
  if (-not $ok) { throw ('UpdateResource group failed: ' + [Runtime.InteropServices.Marshal]::GetLastWin32Error()) }
  for ($i = 0; $i -lt $count; $i++) {
    $img = New-Object byte[] $entries[$i].Size
    [Array]::Copy($bytes, $entries[$i].Off, $img, 0, $entries[$i].Size)
    $ok = [ResWriter]::UpdateResource($h, [IntPtr]3, [IntPtr]($i+1), 0, $img, [uint32]$img.Length)
    if (-not $ok) { throw ('UpdateResource image ' + $i + ' failed: ' + [Runtime.InteropServices.Marshal]::GetLastWin32Error()) }
  }
  if (-not [ResWriter]::EndUpdateResource($h, $false)) { throw 'EndUpdateResource failed' }
  Write-Host ('icon injected into ' + (Split-Path $ExePath -Leaf))
} catch {
  [ResWriter]::EndUpdateResource($h, $true) | Out-Null
  throw
}