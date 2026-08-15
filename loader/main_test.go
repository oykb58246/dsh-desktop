// Regression test for the installer pipeline: readManifests + extractFile +
// the install-time warm-up and the 99% → 100% initialization phase. Builds a
// minimal fake installer (payload-less loader prefix + shell/runtime
// containers in the exact shipped layout) and runs installTo into a temp dir.
// The privileged post-steps (registry, shortcuts, C:\dsh-desktop.ini, Defender
// exclusion) are only exercised in a NON-elevated run, where they fail
// silently and harmlessly; an elevated environment skips the test entirely.
package main

import (
	"encoding/binary"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// buildFakeInstaller writes a fake installer exe with two tiny shell files and
// two tiny runtime files, returning its path.
func buildFakeInstaller(t *testing.T, dir string) string {
	t.Helper()
	const magicShell = "DSHSHL01"
	const magicRuntime = "DSHPLD01"

	loader := []byte("FAKELOADERPREFIX0123456789")
	shellFiles := []fileEntry{
		{Path: "shell-a.txt", Offset: int64(len(loader)), Size: 4},
		{Path: "sub/shell-b.txt", Offset: int64(len(loader) + 4), Size: 6},
	}
	shellManifest, _ := json.Marshal(shellManifest{Files: shellFiles})
	shellEnd := shellFiles[1].Offset + shellFiles[1].Size + int64(len(shellManifest)) + 4 + 8

	runtimeFiles := []fileEntry{
		{Path: "rt-a.js", Offset: shellEnd, Size: 5},
		{Path: "rt-dir/rt-b.js", Offset: shellEnd + 5, Size: 7},
	}
	runtimeManifest, _ := json.Marshal(runtimeManifest{ShellManifestLen: len(shellManifest), Files: runtimeFiles})

	var buf []byte
	buf = append(buf, loader...)
	buf = append(buf, []byte("AAAA")...)   // shell-a.txt content
	buf = append(buf, []byte("BBBBBB")...) // sub/shell-b.txt content
	buf = append(buf, shellManifest...)
	len4 := make([]byte, 4)
	binary.LittleEndian.PutUint32(len4, uint32(len(shellManifest)))
	buf = append(buf, len4...)
	buf = append(buf, magicShell...)
	buf = append(buf, []byte("CCCCC")...)   // rt-a.js content
	buf = append(buf, []byte("DDDDDDD")...) // rt-dir/rt-b.js content
	buf = append(buf, runtimeManifest...)
	binary.LittleEndian.PutUint32(len4, uint32(len(runtimeManifest)))
	buf = append(buf, len4...)
	buf = append(buf, magicRuntime...)

	path := filepath.Join(dir, "fake-setup.exe")
	if err := os.WriteFile(path, buf, 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestEditControlRectCentersInSlot(t *testing.T) {
	rc := editControlRect(90, 232, 470, 36, 22)
	if rc.left != 90 || rc.right != 560 {
		t.Fatalf("horizontal box = {%d,%d}, want {90,560}", rc.left, rc.right)
	}
	if got := rc.bottom - rc.top; got != 22 {
		t.Fatalf("height = %d, want 22", got)
	}
	if rc.top != 232+(36-22)/2 {
		t.Fatalf("top = %d, want centered 239", rc.top)
	}
	// Font taller than the slot must clamp, not overflow the visual box.
	clamped := editControlRect(90, 232, 470, 36, 40)
	if clamped.top != 232 || clamped.bottom != 268 {
		t.Fatalf("clamped = {%d,%d}, want {232,268}", clamped.top, clamped.bottom)
	}
	// Non-positive font height falls back to 20px, still centered.
	fallback := editControlRect(90, 232, 470, 36, 0)
	if fallback.bottom-fallback.top != 20 || fallback.top != 240 {
		t.Fatalf("fallback = {%d,%d}, want 20px at y=240", fallback.top, fallback.bottom)
	}
}

func TestInstallToPipeline(t *testing.T) {
	if isElevated() {
		t.Skip("elevated run would really write C:\\dsh-desktop.ini / registry / shortcuts")
	}
	// Replace the real executable path with the fake installer: installTo reads
	// manifests from os.Executable() unless installerExePath is set.
	old := installerExePath
	defer func() { installerExePath = old }()

	work, err := os.MkdirTemp("", "dsh-install-test-*")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(work)

	fake := buildFakeInstaller(t, work)
	installerExePath = fake
	target := filepath.Join(work, "target")

	if err := installTo(target); err != nil {
		t.Fatalf("installTo: %v", err)
	}

	for _, want := range []string{
		"shell-a.txt",
		filepath.Join("sub", "shell-b.txt"),
		filepath.Join("resources", "dsh-runtime", "rt-a.js"),
		filepath.Join("resources", "dsh-runtime", "rt-dir", "rt-b.js"),
	} {
		got, err := os.ReadFile(filepath.Join(target, want))
		if err != nil {
			t.Fatalf("missing %s: %v", want, err)
		}
		if len(got) == 0 {
			t.Fatalf("%s extracted empty", want)
		}
	}

	if progressPct != 1 {
		t.Fatalf("progressPct = %v, want 1 after completion", progressPct)
	}
	if statusText != "100%" {
		t.Fatalf("statusText = %q, want 100%%", statusText)
	}
}

// TestRunningUnder verifies the running-process scan finds the DSH Desktop
// processes installed on this machine (the app under D:\Program Files), and
// that the scan excludes the test process itself.
func TestRunningUnder(t *testing.T) {
	installed := `D:\Program Files\DSH Desktop`
	if _, err := os.Stat(filepath.Join(installed, "DSH Desktop.exe")); err != nil {
		t.Skip("no installed DSH Desktop on this machine")
	}
	pids := runningUnder(installed)
	if len(pids) == 0 {
		t.Fatalf("runningUnder(%q) found no processes, want >= 1", installed)
	}
	self := os.Getpid()
	for _, pid := range pids {
		if pid == self {
			t.Fatalf("runningUnder included the test process itself (%d)", pid)
		}
	}
	// A directory that cannot contain the running app must yield nothing.
	if other := runningUnder(filepath.Join(os.TempDir(), "dsh-nonexistent-dir")); len(other) != 0 {
		t.Fatalf("runningUnder(nonexistent dir) = %v, want empty", other)
	}
}
