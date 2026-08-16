// Uninstall.exe — lives in the DSH Desktop install directory.
//
// Confirms, then hands cleanup to an elevated PowerShell script in %TEMP%
// so this process can exit before its own directory is deleted.
package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"
)

const (
	appGUID        = "2964e23e-3f18-500c-b3e7-68e9fa24df7a"
	createNoWindow = 0x08000000
	mbYesNo        = 0x0004
	mbIconWarning  = 0x0030
	mbDefButton2   = 0x0100
	idYes          = 6
)

var (
	user32          = syscall.NewLazyDLL("user32.dll")
	procMessageBoxW = user32.NewProc("MessageBoxW")
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

func hideConsole(cmd *exec.Cmd) *exec.Cmd {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
	return cmd
}

func writeScript(target string) (string, error) {
	escaped := strings.ReplaceAll(target, "'", "''")
	body := strings.Join([]string{
		"$ErrorActionPreference = 'SilentlyContinue'",
		"$target = '" + escaped + "'",
		"Start-Sleep -Seconds 2",
		`Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.ToLower().StartsWith($target.TrimEnd('\').ToLower() + '\') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`,
		"Start-Sleep -Seconds 1",
		"try { Remove-MpPreference -ExclusionPath $target -ErrorAction SilentlyContinue } catch {}",
		"Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction SilentlyContinue",
		`Remove-Item -LiteralPath 'C:\Users\Public\Desktop\DSH Desktop.lnk' -Force`,
		`Remove-Item -LiteralPath 'C:\ProgramData\Microsoft\Windows\Start Menu\Programs\DSH Desktop.lnk' -Force`,
		`Remove-Item -LiteralPath 'C:\ProgramData\Microsoft\Windows\Start Menu\Programs\卸载 DSH Desktop.lnk' -Force`,
		`Remove-Item -LiteralPath (Join-Path $env:USERPROFILE 'Desktop\DSH Desktop.lnk') -Force`,
		`Remove-Item -LiteralPath (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\DSH Desktop.lnk') -Force`,
		`Remove-Item -LiteralPath (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\卸载 DSH Desktop.lnk') -Force`,
		`Remove-Item -LiteralPath 'C:\dsh-desktop.ini' -Force`,
		"reg delete 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\" + appGUID + "' /f",
		"Add-Type -AssemblyName PresentationFramework",
		"[System.Windows.MessageBox]::Show('DSH Desktop 已卸载。','DSH Desktop')",
		"",
	}, "\r\n")
	path := filepath.Join(os.TempDir(), "dsh-desktop-uninstall.ps1")
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		return "", err
	}
	return path, nil
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

	script, err := writeScript(target)
	if err != nil {
		messageBox("无法写入卸载脚本："+err.Error(), "卸载 DSH Desktop", 0x10)
		os.Exit(1)
	}
	quoted := strings.ReplaceAll(script, "'", "''")
	cmd := hideConsole(exec.Command(
		"powershell.exe",
		"-NoProfile",
		"-NonInteractive",
		"-Command",
		"Start-Process powershell.exe -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File \""+quoted+"\"' -Verb RunAs",
	))
	if err := cmd.Start(); err != nil {
		messageBox("无法启动卸载："+err.Error(), "卸载 DSH Desktop", 0x10)
		os.Exit(1)
	}
}
