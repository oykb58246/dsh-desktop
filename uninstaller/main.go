// Uninstall.exe — lives in the DSH Desktop install directory.
//
// Confirms, then hands cleanup to an elevated PowerShell script in %TEMP%
// so this process can exit before its own directory is deleted.
//
// The elevated process MUST start with cwd outside the install tree.
// Explorer / Settings launch this exe with cwd = the install directory;
// Remove-Item / rmdir of the current directory silently fails and leaves
// every file behind while still showing “已卸载”.
package main

import (
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"
)

const (
	appGUID        = "2964e23e-3f18-500c-b3e7-68e9fa24df7a"
	mbYesNo        = 0x0004
	mbIconWarning  = 0x0030
	mbDefButton2   = 0x0100
	mbIconError    = 0x0010
	idYes          = 6
	swShownormal   = 1
	errorCancelled = 1223
)

var (
	user32            = syscall.NewLazyDLL("user32.dll")
	shell32           = syscall.NewLazyDLL("shell32.dll")
	procMessageBoxW   = user32.NewProc("MessageBoxW")
	procShellExecuteW = shell32.NewProc("ShellExecuteW")
)

func utf16Ptr(s string) *uint16 {
	p, _ := syscall.UTF16PtrFromString(s)
	return p
}

func messageBox(text, caption string, flags uint) int {
	r, _, _ := procMessageBoxW.Call(
		0,
		uintptr(unsafe.Pointer(utf16Ptr(text))),
		uintptr(unsafe.Pointer(utf16Ptr(caption))),
		uintptr(flags),
	)
	return int(r)
}

func writeUTF8BOM(path, content string) error {
	return os.WriteFile(path, append([]byte{0xEF, 0xBB, 0xBF}, []byte(content)...), 0o644)
}

func writeScript(target string, silent bool) (string, error) {
	escaped := strings.ReplaceAll(target, "'", "''")
	doneMsg := "[System.Windows.MessageBox]::Show('DSH Desktop 已卸载。','DSH Desktop')"
	failMsg := "[System.Windows.MessageBox]::Show('卸载未完成：部分文件仍留在 ' + $target + '。请关闭占用后手动删除该目录。','DSH Desktop')"
	finish := "Add-Type -AssemblyName PresentationFramework" + "\r\n" +
		"if (Test-Path -LiteralPath $target) { " + failMsg + " } else { " + doneMsg + " }"
	if silent {
		finish = ""
	}
	body := strings.Join([]string{
		"$ErrorActionPreference = 'Continue'",
		"$target = '" + escaped + "'",
		"Set-Location $env:TEMP",
		"Start-Sleep -Seconds 2",
		`Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.ToLower().StartsWith($target.TrimEnd('\').ToLower() + '\') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`,
		"Start-Sleep -Seconds 1",
		"try { Remove-MpPreference -ExclusionPath $target -ErrorAction SilentlyContinue } catch {}",
		`if (Test-Path -LiteralPath $target) { cmd.exe /c ('rmdir /s /q "' + $target + '"') }`,
		"if (Test-Path -LiteralPath $target) { Get-ChildItem -LiteralPath $target -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue; Remove-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue }",
		"$sh = New-Object -ComObject WScript.Shell",
		`$lnkDirs = @('C:\Users\Public\Desktop', 'C:\ProgramData\Microsoft\Windows\Start Menu\Programs', (Join-Path $env:USERPROFILE 'Desktop'), (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'))`,
		"foreach ($d in $lnkDirs) {",
		"  if (-not (Test-Path -LiteralPath $d)) { continue }",
		"  Get-ChildItem -LiteralPath $d -Filter '*.lnk' -ErrorAction SilentlyContinue | ForEach-Object {",
		"    try {",
		"      $tp = [string]$sh.CreateShortcut($_.FullName).TargetPath",
		"      if (-not $tp) { return }",
		"      $low = $tp.ToLowerInvariant(); $root = $target.TrimEnd('\\').ToLowerInvariant()",
		"      if ($low -eq ($root + '\\dsh desktop.exe') -or $low -eq ($root + '\\uninstall.exe')) {",
		"        Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue",
		"      }",
		"    } catch {}",
		"  }",
		"}",
		// Keep C:\dsh-desktop.ini so the next installer still defaults to
		// the last InstallPath.
		"reg delete 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\" + appGUID + "' /f",
		finish,
		"",
	}, "\r\n")
	path := filepath.Join(os.TempDir(), "dsh-desktop-uninstall.ps1")
	if err := writeUTF8BOM(path, body); err != nil {
		return "", err
	}
	return path, nil
}

func startElevatedPowerShell(script string) uintptr {
	ps := filepath.Join(os.Getenv("SystemRoot"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
	params := "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"" + script + "\""
	r, _, _ := procShellExecuteW.Call(
		0,
		uintptr(unsafe.Pointer(utf16Ptr("runas"))),
		uintptr(unsafe.Pointer(utf16Ptr(ps))),
		uintptr(unsafe.Pointer(utf16Ptr(params))),
		uintptr(unsafe.Pointer(utf16Ptr(os.TempDir()))),
		swShownormal,
	)
	return r
}

func main() {
	silent := false
	for _, arg := range os.Args[1:] {
		if arg == "--silent" {
			silent = true
		}
	}

	exe, err := os.Executable()
	if err != nil {
		os.Exit(1)
	}
	target, err := filepath.Abs(filepath.Dir(exe))
	if err != nil {
		os.Exit(1)
	}

	if !silent {
		answer := messageBox(
			"确定要卸载 DSH Desktop 吗？\n\n将删除安装目录、开始菜单和桌面快捷方式，以及 Windows 应用列表中的卸载项。\n对话和设置会留在用户目录，不会删除。",
			"卸载 DSH Desktop",
			mbYesNo|mbIconWarning|mbDefButton2,
		)
		if answer != idYes {
			return
		}
	}

	script, err := writeScript(target, silent)
	if err != nil {
		if !silent {
			messageBox("无法写入卸载脚本："+err.Error(), "卸载 DSH Desktop", mbIconError)
		}
		os.Exit(1)
	}
	code := startElevatedPowerShell(script)
	if code <= 32 || code == errorCancelled {
		if !silent {
			messageBox("卸载需要管理员权限。若已取消 UAC，请重新运行 Uninstall.exe。", "卸载 DSH Desktop", mbIconError)
		}
		os.Exit(1)
	}
}
