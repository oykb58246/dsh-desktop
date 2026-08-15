// DSH Desktop — fully native Go installer.
//
// A single executable that opens its window INSTANTLY (native Win32), walks
// 选择目录 → 安装进度 → 完成(可选启动), and only on "安装" extracts the
// bundled data (appended shell + runtime containers produced by
// scripts/append-payload.mjs) straight into the chosen directory.
//
// Container layout: [exe][shell files][shell manifest][u32 len][DSHSHL01][runtime files][runtime manifest][u32 len][DSHPLD01]
package main

import (
	"bytes"
	_ "embed"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	_ "image/png"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

//go:embed installer-bg.png
var bgPng []byte

//go:embed icon.ico
var iconIco []byte

const (
	magicShell   = "DSHSHL01"
	magicRuntime = "DSHPLD01"
	winW, winH   = 760, 480
	barH         = 40
)

const (
	WS_POPUP            = 0x80000000
	WS_VISIBLE          = 0x10000000
	WS_CLIPCHILDREN     = 0x02000000
	WS_CHILD            = 0x40000000
	WS_TABSTOP          = 0x00010000
	ES_AUTOHSCROLL      = 0x0080
	CS_HREDRAW          = 0x0002
	CS_VREDRAW          = 0x0001
	SW_SHOW             = 5
	SW_HIDE             = 0
	WM_DESTROY          = 0x0002
	WM_ERASEBKGND       = 0x0014
	WM_LBUTTONDOWN      = 0x0201
	WM_CLOSE            = 0x0010
	WM_SYSCOMMAND       = 0x0112
	WM_CTLCOLOREDIT     = 0x0133
	WM_SETFONT          = 0x0030
	WM_PAINT            = 0x000F
	EM_SETMARGINS       = 0x00D3
	EC_LEFTMARGIN       = 0x0001
	EC_RIGHTMARGIN      = 0x0002
	SC_MINIMIZE         = 0xF020
	DIB_RGB_COLORS      = 0
	SRCCOPY             = 0x00CC0020
	TRANSPARENT         = 1
	DT_CENTER           = 0x0001
	DT_VCENTER          = 0x0004
	DT_WORDBREAK        = 0x0010
	DT_SINGLELINE       = 0x0020
	SM_CXSCREEN         = 0
	SM_CYSCREEN         = 1
	BIF_NEWDIALOGSTYLE  = 0x0040
	BIF_RETURNONLYFSDIR = 0x0001
	IMAGE_ICON          = 1
	LR_LOADFROMFILE     = 0x00000010
	ICON_SMALL          = 0
	ICON_BIG            = 1
)

type fileEntry struct {
	Path   string `json:"path"`
	Offset int64  `json:"offset"`
	Size   int64  `json:"size"`
}

type shellManifest struct {
	Files []fileEntry `json:"files"`
}

type runtimeManifest struct {
	ShellManifestLen int         `json:"shellManifestLen"`
	Files            []fileEntry `json:"files"`
}

type rect struct{ left, top, right, bottom int32 }
type point struct{ x, y int32 }
type msg struct {
	hwnd    uintptr
	message uint32
	wParam  uintptr
	lParam  uintptr
	time    uint32
	pt      point
}
type wndclass struct {
	style         uint32
	lpfnWndProc   uintptr
	cbClsExtra    int32
	cbWndExtra    int32
	hInstance     uintptr
	hIcon         uintptr
	hCursor       uintptr
	hbrBackground uintptr
	lpszMenuName  *uint16
	lpszClassName *uint16
}
type bitMapInfoHeader struct {
	biSize          uint32
	biWidth         int32
	biHeight        int32
	biPlanes        uint16
	biBitCount      uint16
	biCompression   uint32
	biSizeImage     uint32
	biXPelsPerMeter int32
	biYPelsPerMeter int32
	biClrUsed       uint32
	biClrImportant  uint32
}
type bitMapInfo struct {
	bmiHeader bitMapInfoHeader
}

// textMetric is the leading fields of TEXTMETRICW. Only tmHeight is used;
// the rest keep the struct layout so GetTextMetricsW writes the right offset.
type textMetric struct {
	tmHeight           int32
	tmAscent           int32
	tmDescent          int32
	tmInternalLeading  int32
	tmExternalLeading  int32
	tmAveCharWidth     int32
	tmMaxCharWidth     int32
	tmWeight           int32
	tmOverhang         int32
	tmDigitizedAspectX int32
	tmDigitizedAspectY int32
	tmFirstChar        uint16
	tmLastChar         uint16
	tmDefaultChar      uint16
	tmBreakChar        uint16
	tmItalic           byte
	tmUnderlined       byte
	tmStruckOut        byte
	tmPitchAndFamily   byte
	tmCharSet          byte
}
type browseInfo struct {
	hwndOwner      uintptr
	pidlRoot       uintptr
	pszDisplayName *uint16
	lpszTitle      *uint16
	ulFlags        uint32
	lpfn           uintptr
	lParam         uintptr
	iImage         int32
}

var (
	user32   = syscall.NewLazyDLL("user32.dll")
	gdi32    = syscall.NewLazyDLL("gdi32.dll")
	kernel32 = syscall.NewLazyDLL("kernel32.dll")
	shell32  = syscall.NewLazyDLL("shell32.dll")
	ole32    = syscall.NewLazyDLL("ole32.dll")

	procRegisterClassW      = user32.NewProc("RegisterClassW")
	procCreateWindowExW     = user32.NewProc("CreateWindowExW")
	procDefWindowProcW      = user32.NewProc("DefWindowProcW")
	procGetMessageW         = user32.NewProc("GetMessageW")
	procTranslateMessage    = user32.NewProc("TranslateMessage")
	procDispatchMessageW    = user32.NewProc("DispatchMessageW")
	procShowWindow          = user32.NewProc("ShowWindow")
	procUpdateWindow        = user32.NewProc("UpdateWindow")
	procGetDC               = user32.NewProc("GetDC")
	procReleaseDC           = user32.NewProc("ReleaseDC")
	procDrawTextW           = user32.NewProc("DrawTextW")
	procGetSystemMetrics    = user32.NewProc("GetSystemMetrics")
	procSetWindowRgn        = user32.NewProc("SetWindowRgn")
	procFillRect            = user32.NewProc("FillRect")
	procPostMessage         = user32.NewProc("PostMessageW")
	procSendMessage         = user32.NewProc("SendMessageW")
	procLoadImageW          = user32.NewProc("LoadImageW")
	procSetWindowTextW      = user32.NewProc("SetWindowTextW")
	procGetWindowTextW      = user32.NewProc("GetWindowTextW")
	procSetFocus            = user32.NewProc("SetFocus")
	procFindWindowW         = user32.NewProc("FindWindowW")
	procSetForegroundWindow = user32.NewProc("SetForegroundWindow")
	procMessageBoxW         = user32.NewProc("MessageBoxW")

	procCreateRoundRectRgn = gdi32.NewProc("CreateRoundRectRgn")
	procFillRgn            = gdi32.NewProc("FillRgn")
	procFrameRgn           = gdi32.NewProc("FrameRgn")
	procCreateCompatibleDC = gdi32.NewProc("CreateCompatibleDC")
	procCreateDIBSection   = gdi32.NewProc("CreateDIBSection")
	procSelectObject       = gdi32.NewProc("SelectObject")
	procBitBlt             = gdi32.NewProc("BitBlt")
	procDeleteDC           = gdi32.NewProc("DeleteDC")
	procDeleteObject       = gdi32.NewProc("DeleteObject")
	procCreateSolidBrush   = gdi32.NewProc("CreateSolidBrush")
	procCreateFontW        = gdi32.NewProc("CreateFontW")
	procSetBkMode          = gdi32.NewProc("SetBkMode")
	procSetBkColor         = gdi32.NewProc("SetBkColor")
	procSetTextColor       = gdi32.NewProc("SetTextColor")
	procGetTextMetricsW    = gdi32.NewProc("GetTextMetricsW")

	procGetModuleHandleW    = kernel32.NewProc("GetModuleHandleW")
	procGetDiskFreeSpaceExW = kernel32.NewProc("GetDiskFreeSpaceExW")
	procGetCurrentProcess   = kernel32.NewProc("GetCurrentProcess")
	procCloseHandle         = kernel32.NewProc("CloseHandle")
	procCreateMutexW        = kernel32.NewProc("CreateMutexW")

	advapi32                = syscall.NewLazyDLL("advapi32.dll")
	procOpenProcessToken    = advapi32.NewProc("OpenProcessToken")
	procGetTokenInformation = advapi32.NewProc("GetTokenInformation")

	procSHBrowseForFolder   = shell32.NewProc("SHBrowseForFolderW")
	procSHGetPathFromIDList = shell32.NewProc("SHGetPathFromIDListW")
	procShellExecuteW       = shell32.NewProc("ShellExecuteW")
	procCoTaskMemFree       = ole32.NewProc("CoTaskMemFree")
)

// colref builds a Win32 COLORREF (0x00BBGGRR) from RGB components, so the
// source colors below read exactly like CSS hex.
func colref(r, g, b uint8) uintptr {
	return uintptr(b)<<16 | uintptr(g)<<8 | uintptr(r)
}

var (
	colPrimary  = colref(0x4D, 0x6B, 0xFE) // #4D6BFE 品牌蓝
	colGhost    = colref(0x30, 0x4A, 0x78) // #304A78 次按钮深蓝
	colBorder   = colref(0x7F, 0x9D, 0xF0) // #7F9DF0 浅蓝描边
	colHeading  = colref(0xF2, 0xF6, 0xFF) // #F2F6FF 标题白
	colTitleBar = colref(0xEE, 0xF3, 0xFF) // #EEF3FF 标题栏文字
	colBody     = colref(0xB1, 0xCE, 0xEF) // #B1CEEF 正文浅蓝
	colStatus   = colref(0xB2, 0xD7, 0xEE) // #B2D7EE 状态浅蓝
	colMuted    = colref(0x7D, 0x97, 0xC4) // #7D97C4 弱化文字
	colGreen    = colref(0x34, 0xD3, 0x99) // #34D399 成功绿
	colWhite    = colref(0xFF, 0xFF, 0xFF)
	colPanel    = colref(0x0C, 0x1F, 0x42) // #0C1F42 面板深蓝
	colEditBg   = colref(0x0A, 0x1A, 0x3A) // #0A1A3A 输入框深蓝
	colTrack    = colref(0x1E, 0x3A, 0x6E) // #1E3A6E 进度条底
	colGlyph    = colref(0xCF, 0xE2, 0xFF) // #CFE2FF 标题栏按钮
	colLabel    = colref(0xDB, 0xE9, 0xFF) // #DBE9FF 复选标签
)

type pageID int

const (
	pageDir pageID = iota
	pageProgress
	pageDone
)

type button struct {
	x, y, w, h int32
	label      string
	primary    bool
	click      func()
}

var (
	hwnd      uintptr
	bgDIB     uintptr
	bgDC      uintptr
	offDC     uintptr
	offDIB    uintptr
	editHwnd  uintptr
	editBrush uintptr
	uiFont    uintptr
	paintMu   sync.Mutex
	lastPaint time.Time

	current       = pageDir
	buttons       []button
	installDir    = defaultInstallDir()
	statusText    = ""
	detailText    = ""
	progressPct   = 0.0
	installing    = false
	launchChecked = true
	doneOk        = false
	doneText      = ""

	// Page headings differ between a fresh install and a self-update
	// (runWorkerMode switches these before the progress page appears).
	progressHeading = "正在安装"
	doneHeading     = "安装完成"

	installSizeBytes int64

	minBtn   = rect{winW - 84, 0, winW - 42, barH}
	closeBtn = rect{winW - 42, 0, winW, barH}

	// Visual path slot (parent-drawn). The native EDIT is shorter than this
	// slot and sits vertically centered inside it — see editControlRect.
	editSlot        = rect{90, 232, 560, 268}
	editSlotX int32 = 90
	editSlotY int32 = 232
	editSlotW int32 = 470
	editSlotH int32 = 36
	editPadX  int32 = 12
	editPadR  int32 = 4
)

func fmtBytes(n uint64) string {
	const GB = uint64(1) << 30
	const MB = uint64(1) << 20
	if n >= GB {
		return fmt.Sprintf("%.1f GB", float64(n)/float64(GB))
	}
	if n >= MB {
		return fmt.Sprintf("%.0f MB", float64(n)/float64(MB))
	}
	return fmt.Sprintf("%d B", n)
}

func freeBytes(path string) uint64 {
	if path == "" {
		return 0
	}
	var free, total, totalFree uint64
	p := utf16Ptr(path)
	r, _, _ := procGetDiskFreeSpaceExW.Call(
		uintptr(unsafe.Pointer(p)),
		uintptr(unsafe.Pointer(&free)),
		uintptr(unsafe.Pointer(&total)),
		uintptr(unsafe.Pointer(&totalFree)),
	)
	if r == 0 {
		return 0
	}
	return free
}

func defaultInstallDir() string {
	if raw, err := os.ReadFile(`C:\dsh-desktop.ini`); err == nil {
		for _, line := range strings.Split(string(raw), "\r\n") {
			if strings.HasPrefix(line, "InstallPath=") {
				dir := strings.TrimSpace(strings.TrimPrefix(line, "InstallPath="))
				if dir != "" {
					return dir
				}
			}
		}
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return `C:\DSH Desktop`
	}
	return filepath.Join(home, "DSH Desktop")
}

func utf16Ptr(s string) *uint16 {
	p, err := syscall.UTF16PtrFromString(s)
	if err != nil {
		return nil
	}
	return p
}

func toRGBA(c color.Color) color.RGBA {
	r, g, b, a := c.RGBA()
	return color.RGBA{uint8(r >> 8), uint8(g >> 8), uint8(b >> 8), uint8(a >> 8)}
}

func makeDib(hdc uintptr, img image.Image) uintptr {
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	bi := bitMapInfo{bmiHeader: bitMapInfoHeader{
		biSize: 40, biWidth: int32(w), biHeight: -int32(h),
		biPlanes: 1, biBitCount: 32, biCompression: 0,
	}}
	var bits unsafe.Pointer
	dib, _, _ := procCreateDIBSection.Call(hdc, uintptr(unsafe.Pointer(&bi)), DIB_RGB_COLORS, uintptr(unsafe.Pointer(&bits)), 0, 0)
	if dib == 0 || bits == nil {
		return 0
	}
	dst := unsafe.Slice((*byte)(bits), w*h*4)
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			i := (y*w + x) * 4
			c := toRGBA(img.At(b.Min.X+x, b.Min.Y+y))
			dst[i] = c.B
			dst[i+1] = c.G
			dst[i+2] = c.R
			dst[i+3] = c.A
		}
	}
	return dib
}

func getDC(h uintptr) uintptr {
	r, _, _ := procGetDC.Call(h)
	return r
}

func releaseDC(h, dc uintptr) {
	procReleaseDC.Call(h, dc)
}

func createCompatibleDC(hdc uintptr) uintptr {
	r, _, _ := procCreateCompatibleDC.Call(hdc)
	return r
}

func makeFont(size int32, bold bool) uintptr {
	weight := 0
	if bold {
		weight = 600
	}
	font, _, _ := procCreateFontW.Call(
		^uintptr(size), 0, 0, 0, uintptr(weight), 0, 0, 0, 0, 0, 0, 0, 0,
		uintptr(unsafe.Pointer(utf16Ptr("Segoe UI"))),
	)
	return font
}

func drawText(dc uintptr, text string, rc rect, colorRef uintptr, size int32, bold bool, flags uint32) {
	procSetBkMode.Call(dc, TRANSPARENT)
	procSetTextColor.Call(dc, colorRef)
	font := makeFont(size, bold)
	if font == 0 {
		return
	}
	old, _, _ := procSelectObject.Call(dc, font)
	if textPtr := utf16Ptr(text); textPtr != nil {
		procDrawTextW.Call(dc, uintptr(unsafe.Pointer(textPtr)), uintptr(^uintptr(0)), uintptr(unsafe.Pointer(&rc)), uintptr(flags))
	}
	procSelectObject.Call(dc, old)
	procDeleteObject.Call(font)
}

func fillRounded(dc uintptr, r rect, colorRef uintptr, radius int32) {
	rgn, _, _ := procCreateRoundRectRgn.Call(uintptr(r.left), uintptr(r.top), uintptr(r.right), uintptr(r.bottom), uintptr(radius), uintptr(radius))
	if rgn == 0 {
		return
	}
	brush, _, _ := procCreateSolidBrush.Call(colorRef)
	procFillRgn.Call(dc, rgn, brush)
	procDeleteObject.Call(brush)
	procDeleteObject.Call(rgn)
}

func drawButton(dc uintptr, b button) {
	fill := colPrimary
	if !b.primary {
		fill = colGhost
	}
	fillRounded(dc, rect{b.x, b.y, b.x + b.w, b.y + b.h}, fill, 10)
	br2, _, _ := procCreateSolidBrush.Call(colBorder)
	rgn2, _, _ := procCreateRoundRectRgn.Call(uintptr(b.x), uintptr(b.y), uintptr(b.x+b.w), uintptr(b.y+b.h), 10, 10)
	procFrameRgn.Call(dc, rgn2, br2, 1, 1)
	procDeleteObject.Call(br2)
	procDeleteObject.Call(rgn2)
	drawText(dc, b.label, rect{b.x, b.y, b.x + b.w, b.y + b.h}, colWhite, 15, true, DT_CENTER|DT_VCENTER|DT_SINGLELINE)
}

func drawTitleBar(dc uintptr) {
	drawText(dc, "DSH Desktop", rect{48, 0, 320, barH}, colTitleBar, 14, true, DT_SINGLELINE|DT_VCENTER)
	// Window buttons share one visual footprint: the minimize bar is drawn as
	// a 12x2 vector (matching the ✕'s ~11px width) so it is pixel-exact and
	// centered, unlike the old 16px "—" vs 14px "✕" text pair whose metrics
	// never lined up. The close ✕ stays a 15px glyph.
	bar := rect{minBtn.left + 15, barH/2 - 1, minBtn.left + 27, barH/2 + 1}
	brush, _, _ := procCreateSolidBrush.Call(colGlyph)
	procFillRect.Call(dc, uintptr(unsafe.Pointer(&bar)), brush)
	procDeleteObject.Call(brush)
	drawText(dc, "✕", rect{closeBtn.left, 0, closeBtn.right, barH}, colGlyph, 15, false, DT_CENTER|DT_VCENTER|DT_SINGLELINE)
}

func paintAll() {
	paintMu.Lock()
	defer paintMu.Unlock()
	now := time.Now()
	if now.Sub(lastPaint) < 40*time.Millisecond && progressPct < 1 {
		return
	}
	lastPaint = now
	if offDC == 0 || bgDC == 0 {
		return
	}
	procBitBlt.Call(offDC, 0, 0, winW, winH, bgDC, 0, 0, SRCCOPY)
	drawTitleBar(offDC)

	switch current {
	case pageDir:
		drawText(offDC, "选择安装目录", rect{70, 78, winW - 70, 122}, colHeading, 24, true, DT_CENTER)
		drawText(offDC, "应用与运行时将安装到所选目录，数据直接从安装器解压。", rect{70, 132, winW - 70, 158}, colBody, 13, false, DT_CENTER)
		// Input row (vertically centered in the content area below the title bar).
		panel := rect{90, 232, 570, 268}
		procFillRect.Call(offDC, uintptr(unsafe.Pointer(&panel)), editBrush)
		cap := "本次安装约需 " + fmtBytes(uint64(installSizeBytes))
		if free := freeBytes(installDir); free > 0 {
			cap += "　·　目标盘剩余 " + fmtBytes(free)
		}
		drawText(offDC, cap, rect{70, 440, winW - 70, 466}, colMuted, 12, false, DT_CENTER)
		for _, b := range buttons {
			drawButton(offDC, b)
		}
	case pageProgress:
		drawText(offDC, progressHeading, rect{70, 84, winW - 70, 130}, colHeading, 24, true, DT_CENTER)
		drawText(offDC, "安装到："+installDir, rect{70, 134, winW - 70, 164}, colBody, 12, false, DT_CENTER|DT_WORDBREAK)
		bar := rect{70, 210, winW - 70, 224}
		track, _, _ := procCreateSolidBrush.Call(colTrack)
		procFillRect.Call(offDC, uintptr(unsafe.Pointer(&bar)), track)
		procDeleteObject.Call(track)
		if progressPct > 0 {
			fillW := int32(float64(winW-140) * progressPct)
			if fillW > 0 {
				fill := rect{70, 210, 70 + fillW, 224}
				fbrush, _, _ := procCreateSolidBrush.Call(colPrimary)
				procFillRect.Call(offDC, uintptr(unsafe.Pointer(&fill)), fbrush)
				procDeleteObject.Call(fbrush)
			}
		}
		pct := int(progressPct * 100)
		drawText(offDC, fmt.Sprintf("%d%%", pct), rect{70, 236, winW - 70, 280}, colHeading, 28, true, DT_CENTER)
		drawText(offDC, statusText, rect{70, 286, winW - 70, 318}, colStatus, 12, false, DT_CENTER)
	case pageDone:
		drawText(offDC, "✓", rect{0, 84, winW, 160}, colGreen, 40, true, DT_CENTER)
		drawText(offDC, doneHeading, rect{70, 168, winW - 70, 214}, colHeading, 24, true, DT_CENTER)
		drawText(offDC, doneText, rect{70, 222, winW - 70, 254}, colBody, 13, false, DT_CENTER)
		box := rect{270, 296, 288, 314}
		boxBrush, _, _ := procCreateSolidBrush.Call(colPrimary)
		procFillRect.Call(offDC, uintptr(unsafe.Pointer(&box)), boxBrush)
		procDeleteObject.Call(boxBrush)
		if launchChecked {
			drawText(offDC, "✓", rect{270, 292, 288, 318}, colWhite, 14, true, DT_CENTER|DT_VCENTER|DT_SINGLELINE)
		}
		drawText(offDC, "启动 DSH Desktop", rect{298, 292, 520, 318}, colLabel, 13, false, DT_SINGLELINE|DT_VCENTER)
		for _, b := range buttons {
			drawButton(offDC, b)
		}
	}
	// Blit once.
	hdc := getDC(hwnd)
	if hdc != 0 {
		procBitBlt.Call(hdc, 0, 0, winW, winH, offDC, 0, 0, SRCCOPY)
		releaseDC(hwnd, hdc)
	}
}

func setPage(p pageID, bs []button) {
	current = p
	buttons = bs
	if editHwnd != 0 {
		if p == pageDir {
			procShowWindow.Call(editHwnd, SW_SHOW)
		} else {
			procShowWindow.Call(editHwnd, SW_HIDE)
		}
	}
	paintAll()
}

func readEditDir() string {
	if editHwnd == 0 {
		return installDir
	}
	buf := make([]uint16, 4096)
	n, _, _ := procGetWindowTextW.Call(editHwnd, uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)))
	if n == 0 {
		return installDir
	}
	dir := strings.TrimSpace(syscall.UTF16ToString(buf))
	if dir == "" {
		return installDir
	}
	return dir
}

func wndProc(h uintptr, message uint32, wParam, lParam uintptr) uintptr {
	switch message {
	case WM_DESTROY:
		procPostMessage.Call(h, 0x0012, 0, 0)
		return 0
	case WM_ERASEBKGND:
		return 1
	case WM_CTLCOLOREDIT:
		procSetTextColor.Call(wParam, colHeading)
		procSetBkColor.Call(wParam, colEditBg)
		return editBrush
	case WM_LBUTTONDOWN:
		x := int32(lParam & 0xFFFF)
		y := int32((lParam >> 16) & 0xFFFF)
		if x >= closeBtn.left && x < closeBtn.right && y >= closeBtn.top && y < closeBtn.bottom {
			procPostMessage.Call(h, WM_CLOSE, 0, 0)
			return 0
		}
		if x >= minBtn.left && x < minBtn.right && y >= minBtn.top && y < minBtn.bottom {
			procPostMessage.Call(h, WM_SYSCOMMAND, SC_MINIMIZE, 0)
			return 0
		}
		if current == pageDir && editHwnd != 0 &&
			x >= editSlot.left && x < editSlot.right && y >= editSlot.top && y < editSlot.bottom {
			// The native EDIT is shorter than the 36px slot; clicks on the
			// top/bottom padding still belong to the path field.
			procSetFocus.Call(editHwnd)
			return 0
		}
		if current == pageDone && x >= 270 && x <= 520 && y >= 292 && y <= 318 {
			launchChecked = !launchChecked
			paintAll()
			return 0
		}
		for _, b := range buttons {
			if x >= b.x && x <= b.x+b.w && y >= b.y && y <= b.y+b.h && b.click != nil {
				b.click()
				break
			}
		}
		return 0
	}
	r, _, _ := procDefWindowProcW.Call(h, uintptr(message), wParam, lParam)
	return r
}

func loadIcon() uintptr {
	tmp := filepath.Join(os.TempDir(), "dsh-installer-icon.ico")
	if err := os.WriteFile(tmp, iconIco, 0o644); err != nil {
		return 0
	}
	defer os.Remove(tmp)
	pathPtr := utf16Ptr(tmp)
	hicon, _, _ := procLoadImageW.Call(0, uintptr(unsafe.Pointer(pathPtr)), IMAGE_ICON, 0, 0, LR_LOADFROMFILE)
	return hicon
}

// editControlRect places a single-line EDIT inside the 36px visual slot so
// the stock control can paint text and caret itself. Subclassing WM_PAINT
// to DT_VCENTER the glyphs looks centered until the user clicks: the original
// EDIT proc then GetDC-paints the same string at the default baseline, which
// is the path-box ghosting this helper exists to avoid.
func editControlRect(slotX, slotY, slotW, slotH, fontH int32) rect {
	if fontH <= 0 {
		fontH = 20
	}
	if fontH > slotH {
		fontH = slotH
	}
	top := slotY + (slotH-fontH)/2
	return rect{slotX, top, slotX + slotW, top + fontH}
}

func measureFontHeight(font uintptr) int32 {
	if font == 0 || hwnd == 0 {
		return 20
	}
	hdc := getDC(hwnd)
	if hdc == 0 {
		return 20
	}
	defer releaseDC(hwnd, hdc)
	old, _, _ := procSelectObject.Call(hdc, font)
	var tm textMetric
	procGetTextMetricsW.Call(hdc, uintptr(unsafe.Pointer(&tm)))
	procSelectObject.Call(hdc, old)
	if tm.tmHeight <= 0 {
		return 20
	}
	// A couple of extra pixels keep descenders / ClearType from clipping
	// against the shorter native EDIT.
	h := tm.tmHeight + 2
	if h > editSlotH {
		return editSlotH
	}
	return h
}

func createEditControl(hInst uintptr) uintptr {
	uiFont = makeFont(15, false)
	rc := editControlRect(editSlotX, editSlotY, editSlotW, editSlotH, measureFontHeight(uiFont))
	clsName := utf16Ptr("EDIT")
	edit, _, _ := procCreateWindowExW.Call(
		0,
		uintptr(unsafe.Pointer(clsName)),
		uintptr(unsafe.Pointer(utf16Ptr(installDir))),
		WS_CHILD|WS_VISIBLE|WS_TABSTOP|ES_AUTOHSCROLL,
		uintptr(rc.left), uintptr(rc.top), uintptr(rc.right-rc.left), uintptr(rc.bottom-rc.top),
		hwnd, 0, hInst, 0,
	)
	if edit != 0 {
		procSendMessage.Call(edit, WM_SETFONT, uiFont, 1)
		margins := uintptr(uint32(editPadX) | uint32(editPadR)<<16)
		procSendMessage.Call(edit, EM_SETMARGINS, EC_LEFTMARGIN|EC_RIGHTMARGIN, margins)
	}
	return edit
}

func createWindow() uintptr {
	hInst, _, _ := procGetModuleHandleW.Call(0)
	clsName := utf16Ptr("DshInstallerWnd")
	hicon := loadIcon()
	wc := wndclass{
		style:         CS_HREDRAW | CS_VREDRAW,
		lpfnWndProc:   syscall.NewCallback(wndProc),
		hInstance:     hInst,
		hIcon:         hicon,
		lpszClassName: clsName,
	}
	procRegisterClassW.Call(uintptr(unsafe.Pointer(&wc)))
	sw, _, _ := procGetSystemMetrics.Call(SM_CXSCREEN)
	sh, _, _ := procGetSystemMetrics.Call(SM_CYSCREEN)
	x := int32((int(sw) - winW) / 2)
	y := int32((int(sh) - winH) / 2)
	h, _, _ := procCreateWindowExW.Call(
		0,
		uintptr(unsafe.Pointer(clsName)),
		uintptr(unsafe.Pointer(utf16Ptr("DSH Desktop"))),
		WS_POPUP|WS_VISIBLE|WS_CLIPCHILDREN,
		uintptr(x), uintptr(y), winW, winH,
		0, 0, hInst, 0,
	)
	if h != 0 {
		if hicon != 0 {
			procSendMessage.Call(h, 0x0080, ICON_BIG, hicon)
			procSendMessage.Call(h, 0x0080, ICON_SMALL, hicon)
		}
		rgn, _, _ := procCreateRoundRectRgn.Call(0, 0, winW+1, winH+1, 18, 18)
		if rgn != 0 {
			procSetWindowRgn.Call(h, rgn, 1)
		}
	}
	return h
}

func runMessageLoop() {
	var m msg
	for {
		r, _, _ := procGetMessageW.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0)
		if r == 0 {
			break
		}
		procTranslateMessage.Call(uintptr(unsafe.Pointer(&m)))
		procDispatchMessageW.Call(uintptr(unsafe.Pointer(&m)))
	}
}

// ---------- containers ----------

func readAtFull(f *os.File, off, n int64) ([]byte, error) {
	buf := make([]byte, n)
	_, err := f.ReadAt(buf, off)
	return buf, err
}

func readManifests(exe string) (shellFiles, runtimeFiles []fileEntry, shellTotal, runtimeTotal int64, err error) {
	f, err := os.Open(exe)
	if err != nil {
		return nil, nil, 0, 0, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, nil, 0, 0, err
	}
	if st.Size() < 12 {
		return nil, nil, 0, 0, fmt.Errorf("installer too small")
	}
	tail, err := readAtFull(f, st.Size()-12, 12)
	if err != nil {
		return nil, nil, 0, 0, err
	}
	if string(tail[4:]) != magicRuntime {
		return nil, nil, 0, 0, fmt.Errorf("runtime section missing")
	}
	mlen := int64(binary.LittleEndian.Uint32(tail[0:4]))
	mbuf, err := readAtFull(f, st.Size()-12-mlen, mlen)
	if err != nil {
		return nil, nil, 0, 0, err
	}
	var rt runtimeManifest
	if err := json.Unmarshal(mbuf, &rt); err != nil {
		return nil, nil, 0, 0, err
	}
	if len(rt.Files) == 0 {
		return nil, nil, 0, 0, fmt.Errorf("runtime manifest empty")
	}
	shellEnd := rt.Files[0].Offset
	shellTail, err := readAtFull(f, shellEnd-12, 12)
	if err != nil {
		return nil, nil, 0, 0, err
	}
	if string(shellTail[4:]) != magicShell {
		return nil, nil, 0, 0, fmt.Errorf("shell section missing")
	}
	slen := int64(binary.LittleEndian.Uint32(shellTail[0:4]))
	smbuf, err := readAtFull(f, shellEnd-12-slen, slen)
	if err != nil {
		return nil, nil, 0, 0, err
	}
	var sm shellManifest
	if err := json.Unmarshal(smbuf, &sm); err != nil {
		return nil, nil, 0, 0, err
	}
	first := sm.Files[0].Offset
	shellTotal = shellEnd - first
	for _, fe := range rt.Files {
		runtimeTotal += fe.Size
	}
	return sm.Files, rt.Files, shellTotal, runtimeTotal, nil
}

// extractFile copies one payload file from the installer exe to dest. When a
// running (or just-quit) app still holds the target (an update overlays the
// live install), locked files are retried for a bounded window before failing.
func extractFile(f *os.File, offset, size int64, dest string, buf []byte) error {
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return err
	}
	var out *os.File
	var err error
	deadline := time.Now().Add(20 * time.Second)
	for {
		out, err = os.Create(dest)
		if err == nil {
			break
		}
		if !isBusyError(err) || time.Now().After(deadline) {
			return err
		}
		time.Sleep(250 * time.Millisecond)
	}
	defer out.Close()
	remaining := size
	pos := offset
	for remaining > 0 {
		n := int64(len(buf))
		if n > remaining {
			n = remaining
		}
		rn, err := f.ReadAt(buf[:n], pos)
		if err != nil && err != io.EOF {
			return err
		}
		if rn == 0 {
			break
		}
		if _, err := out.Write(buf[:rn]); err != nil {
			return err
		}
		pos += int64(rn)
		remaining -= int64(rn)
	}
	return nil
}

// isBusyError reports whether err is a transient file-lock failure worth
// retrying during an overlay update (ERROR_SHARING_VIOLATION=32,
// ERROR_LOCK_VIOLATION=33).
func isBusyError(err error) bool {
	if err == nil {
		return false
	}
	pathErr, ok := err.(*os.PathError)
	if !ok {
		return false
	}
	switch pathErr.Err {
	case syscall.Errno(32), syscall.ERROR_ACCESS_DENIED, syscall.Errno(33):
		return true
	}
	return false
}

// installerExePath overrides os.Executable() in installTo; tests point it at a
// fake container so the pipeline runs without a real payload exe.
var installerExePath = ""

func installTo(target string) error {
	exe := installerExePath
	if exe == "" {
		var err error
		exe, err = os.Executable()
		if err != nil {
			return err
		}
	}
	shellFiles, runtimeFiles, _, _, err := readManifests(exe)
	if err != nil {
		return err
	}
	f, err := os.Open(exe)
	if err != nil {
		return err
	}
	defer f.Close()
	total := int64(len(shellFiles) + len(runtimeFiles))
	var done int64
	buf := make([]byte, 1<<20)
	report := func(name string) {
		done++
		// Cap at 99% while copying: the final percent belongs to the
		// initialization phase below, so the bar visibly holds at 99% while
		// the app tree is warmed and registered.
		progressPct = float64(done) / float64(total) * 0.99
		statusText = fmt.Sprintf("%d/%d · %s", done, total, name)
		paintAll()
	}
	warmDone := make(chan struct{})
	go warmWorker(warmDone)
	for _, fe := range shellFiles {
		dest := filepath.Join(target, filepath.FromSlash(fe.Path))
		if err := extractFile(f, fe.Offset, fe.Size, dest, buf); err != nil {
			return err
		}
		warmQueue <- dest
		report(fe.Path)
	}
	for _, fe := range runtimeFiles {
		dest := filepath.Join(target, "resources", "dsh-runtime", filepath.FromSlash(fe.Path))
		if err := extractFile(f, fe.Offset, fe.Size, dest, buf); err != nil {
			return err
		}
		warmQueue <- dest
		report(fe.Path)
	}
	// Files are copied (99%): finish initializing off-screen — drain the
	// warm-up read-back (OS cache + antivirus scan of the fresh tree), then
	// the registry/shortcuts/Defender steps — before declaring completion.
	statusText = "正在初始化应用…"
	paintAll()
	close(warmQueue)
	<-warmDone
	_ = writeIni(target)
	_ = registerApp(target)
	_ = createShortcuts(target)
	defenderExclude(target)
	progressPct = 1
	statusText = "100%"
	paintAll()
	return nil
}

func writeIni(target string) error {
	return os.WriteFile(`C:\dsh-desktop.ini`, []byte("[DSH Desktop]\r\nInstallPath="+target+"\r\n"), 0o644)
}

// hideConsole runs a child command with no console window at all. The loader
// is a GUI-subsystem exe (built with -H windowsgui); without CREATE_NO_WINDOW
// every console-subsystem child (reg, powershell) would flash its own console
// during install.
func hideConsole(cmd *exec.Cmd) *exec.Cmd {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x08000000} // CREATE_NO_WINDOW
	return cmd
}

// ---------- elevation ----------

const (
	tokenQuery    = 0x0008
	tokenElevated = 20
	swShownormal  = 1
)

type tokenElevation struct {
	TokenIsElevated uint32
}

// isElevated reports whether the process runs with an elevated (administrator)
// token: writing HKLM, C:\dsh-desktop.ini, ProgramData shortcuts and the
// Defender exclusion all require it.
func isElevated() bool {
	cur, _, _ := procGetCurrentProcess.Call()
	var hToken uintptr
	r, _, _ := procOpenProcessToken.Call(cur, tokenQuery, uintptr(unsafe.Pointer(&hToken)))
	if r == 0 || hToken == 0 {
		return false
	}
	defer procCloseHandle.Call(hToken)
	var el tokenElevation
	var retLen uint32
	r, _, _ = procGetTokenInformation.Call(hToken, tokenElevated, uintptr(unsafe.Pointer(&el)), uintptr(unsafe.Sizeof(el)), uintptr(unsafe.Pointer(&retLen)))
	return r != 0 && el.TokenIsElevated != 0
}

// relaunchElevated restarts the installer through the UAC prompt (runas verb),
// passing the given arguments. Returns true when an elevated copy was started
// (the caller should then quit); false when the user cancelled the prompt or
// the launch failed (the caller may proceed with a normal token — extraction
// works, only the privileged post-steps degrade).
func relaunchElevated(args ...string) bool {
	exe, err := os.Executable()
	if err != nil {
		return false
	}
	params := ""
	for _, a := range args {
		params += " \"" + a + "\""
	}
	r, _, _ := procShellExecuteW.Call(
		0,
		uintptr(unsafe.Pointer(utf16Ptr("runas"))),
		uintptr(unsafe.Pointer(utf16Ptr(exe))),
		uintptr(unsafe.Pointer(utf16Ptr(params))),
		0, swShownormal,
	)
	return r > 32
}

// defenderExclude adds the install directory to Windows Defender's exclusion
// list (best-effort; requires the elevated token the installer runs with).
// Real-time scanning of the freshly extracted 14k-file runtime is the dominant
// cold-start cost after install, so excluding the app's own directory makes
// the first launch (and every launch) start without it. The uninstaller
// (electron/main.mjs runUninstallWorker) removes the exclusion.
func defenderExclude(target string) {
	escaped := strings.ReplaceAll(target, "'", "''")
	ps := "try { Add-MpPreference -ExclusionPath '" + escaped + "' -ErrorAction Stop } catch {}"
	hideConsole(exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", ps)).Run()
}

// ---------- single instance ----------

const (
	errorAlreadyExists = 183 // ERROR_ALREADY_EXISTS
	mbYesNo            = 0x0004
	mbIconWarning      = 0x0030
	mbDefButton2       = 0x0100
	idYes              = 6
)

var instanceMutex uintptr

// acquireSingleInstance takes the per-session installer mutex, so a second
// double-click activates the existing window instead of opening another
// installer. During an elevation handoff (--dir) the previous process is
// shutting down, so the mutex is retried briefly before giving up.
func acquireSingleInstance(handoff bool) bool {
	name := "Local\\dsh-desktop-installer-2964e23e-3f18-500c-b3e7-68e9fa24df7a"
	deadline := time.Now().Add(3 * time.Second)
	for {
		h, _, callErr := procCreateMutexW.Call(0, 1, uintptr(unsafe.Pointer(utf16Ptr(name))))
		if h == 0 {
			return false
		}
		// syscall captures GetLastError right after the call; re-reading it
		// through a second proc would return a stale value.
		if callErr != syscall.Errno(errorAlreadyExists) {
			instanceMutex = h
			return true
		}
		procCloseHandle.Call(h)
		if !handoff || time.Now().After(deadline) {
			return false
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// releaseSingleInstance drops the mutex before the elevation handoff, so the
// elevated successor can take it over instead of seeing a "second instance".
func releaseSingleInstance() {
	if instanceMutex != 0 {
		procCloseHandle.Call(instanceMutex)
		instanceMutex = 0
	}
}

// activateExistingInstaller brings an already-open installer window to the
// front; the duplicate process then exits.
func activateExistingInstaller() {
	w, _, _ := procFindWindowW.Call(uintptr(unsafe.Pointer(utf16Ptr("DshInstallerWnd"))), 0)
	if w != 0 {
		procSetForegroundWindow.Call(w)
	}
}

// ---------- running-process check ----------

// runningUnder returns the PIDs of processes whose executable lives under
// dir (the install target): installing over a running app would fail on
// locked files, so the user is asked first (see startInstall). The
// installer's own PID is never included.
func runningUnder(dir string) []int {
	escaped := strings.ReplaceAll(dir, "'", "''")
	ps := "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and " +
		"$_.ExecutablePath.ToLower().StartsWith('" + escaped + "'.TrimEnd('\\').ToLower() + '\\') } " +
		"| Select-Object -ExpandProperty ProcessId"
	out, err := hideConsole(exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", ps)).Output()
	if err != nil {
		return nil
	}
	var pids []int
	for _, line := range strings.Split(string(out), "\r\n") {
		line = strings.TrimSpace(line)
		if n, err := strconv.Atoi(line); err == nil && n > 0 && n != os.Getpid() {
			pids = append(pids, n)
		}
	}
	return pids
}

// killProcesses force-kills each PID with its whole process tree (the DSH app
// keeps harness child processes alive).
func killProcesses(pids []int) {
	for _, pid := range pids {
		hideConsole(exec.Command("taskkill", "/PID", strconv.Itoa(pid), "/F", "/T")).Run()
	}
}

// ---------- install-time file warm-up ----------

// warmQueue receives fully written install files to read back into the OS
// cache — and through the antivirus scanner — while extraction is still
// running. The first launch then finds scanned, cached files instead of
// paying the cold read + scan cost on screen.
var warmQueue = make(chan string, 1024)

// warmWorker drains warmQueue, reading every file back in 1 MiB chunks. It
// closes warmDone when the queue is empty.
func warmWorker(warmDone chan struct{}) {
	defer close(warmDone)
	buf := make([]byte, 1<<20)
	for p := range warmQueue {
		f, err := os.Open(p)
		if err != nil {
			continue
		}
		for {
			if _, err := f.Read(buf); err != nil {
				break
			}
		}
		f.Close()
	}
}

func registerApp(target string) error {
	exe := filepath.Join(target, "DSH Desktop.exe")
	key := `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\2964e23e-3f18-500c-b3e7-68e9fa24df7a`
	values := [][2]string{
		{"DisplayName", "DSH Desktop"},
		{"DisplayVersion", "0.1.2"},
		{"Publisher", "DSH Desktop"},
		{"InstallLocation", target},
		{"UninstallString", `"` + exe + `" --uninstall`},
		{"DisplayIcon", exe + ",0"},
	}
	for _, v := range values {
		_ = hideConsole(exec.Command("reg", "add", key, "/v", v[0], "/d", v[1], "/f")).Run()
	}
	return nil
}

func createShortcuts(target string) error {
	exe := filepath.Join(target, "DSH Desktop.exe")
	ps := "$ws = New-Object -ComObject WScript.Shell;"
	ps += " foreach ($p in @('" + os.Getenv("USERPROFILE") + "\\Desktop\\DSH Desktop.lnk', '" + os.Getenv("APPDATA") + "\\Microsoft\\Windows\\Start Menu\\Programs\\DSH Desktop.lnk')) {"
	ps += " $s = $ws.CreateShortcut($p); $s.TargetPath = '" + exe + "'; $s.IconLocation = '" + exe + ",0'; $s.Save() }"
	return hideConsole(exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", ps)).Run()
}

// ---------- UI actions ----------

func browseDir() {
	buf := make([]uint16, 4096)
	bi := browseInfo{
		hwndOwner:      hwnd,
		pszDisplayName: &buf[0],
		lpszTitle:      utf16Ptr("选择安装目录"),
		ulFlags:        BIF_NEWDIALOGSTYLE | BIF_RETURNONLYFSDIR,
	}
	pidl, _, _ := procSHBrowseForFolder.Call(uintptr(unsafe.Pointer(&bi)))
	if pidl == 0 {
		return
	}
	pathBuf := make([]uint16, 4096)
	r, _, _ := procSHGetPathFromIDList.Call(pidl, uintptr(unsafe.Pointer(&pathBuf[0])))
	procCoTaskMemFree.Call(pidl)
	if r != 0 {
		dir := syscall.UTF16ToString(pathBuf)
		installDir = dir
		if editHwnd != 0 {
			procSetWindowTextW.Call(editHwnd, uintptr(unsafe.Pointer(utf16Ptr(dir))))
		}
	}
}

func showDirPage() {
	setPage(pageDir, []button{
		{x: 570, y: 232, w: 100, h: 36, label: "浏览…", primary: false, click: browseDir},
		{x: 590, y: 386, w: 130, h: 44, label: "安装", primary: true, click: startInstall},
	})
}

func startInstall() {
	if installing {
		return
	}
	installing = true
	installDir = readEditDir()
	// The post-install steps (HKLM uninstall key, C:\dsh-desktop.ini,
	// ProgramData shortcuts, Defender exclusion) need an elevated token:
	// relaunch through UAC with the chosen directory and let the elevated
	// copy run the whole install. DSH_SETUP_NO_ELEVATE=1 (automation/UI
	// runs) or a cancelled prompt falls through to a normal-token install,
	// where extraction works and the privileged steps degrade silently.
	if os.Getenv("DSH_SETUP_NO_ELEVATE") == "" && !isElevated() {
		if relaunchElevated("--dir", installDir) {
			// The elevated successor owns the window from here on: free the
			// single-instance mutex for it and close this instance.
			releaseSingleInstance()
			procPostMessage.Call(hwnd, WM_CLOSE, 0, 0)
			return
		}
	}
	// Installing over a running app would fail on locked files: ask the user
	// before terminating any DSH Desktop processes under the target.
	if pids := runningUnder(installDir); len(pids) > 0 {
		msg := fmt.Sprintf("检测到 %d 个 DSH Desktop 进程正在运行（安装目录：%s）。\n\n"+
			"点击「是」将立即终止这 %d 个进程并继续安装，未保存的会话数据可能丢失。\n"+
			"点击「否」将取消本次安装，请先手动关闭 DSH Desktop 后再试。",
			len(pids), installDir, len(pids))
		// MessageBoxW(hWnd, lpText, lpCaption, uType): the message belongs in
		// the body (lpText), the short window title in lpCaption — these were
		// swapped once and the body only ever showed the caption.
		r, _, _ := procMessageBoxW.Call(hwnd, uintptr(unsafe.Pointer(utf16Ptr(msg))), uintptr(unsafe.Pointer(utf16Ptr("DSH Desktop 安装"))), mbYesNo|mbIconWarning|mbDefButton2)
		if r != idYes {
			installing = false
			return
		}
		killProcesses(pids)
		// Give the terminated processes a moment to release their files.
		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) {
			if len(runningUnder(installDir)) == 0 {
				break
			}
			time.Sleep(250 * time.Millisecond)
		}
	}
	progressPct = 0
	statusText = "准备安装…"
	setPage(pageProgress, nil)
	go func() {
		err := installTo(installDir)
		if err != nil {
			installing = false
			doneOk = false
			doneText = "安装失败：" + err.Error()
			setPage(pageDone, []button{
				{x: 590, y: 386, w: 130, h: 44, label: "关闭", primary: true, click: func() {
					procPostMessage.Call(hwnd, WM_CLOSE, 0, 0)
				}},
			})
			return
		}
		installing = false
		doneOk = true
		doneText = "数据已写入：" + installDir
		progressPct = 1
		statusText = "100%"
		paintAll()
		setPage(pageDone, []button{
			{x: 590, y: 386, w: 130, h: 44, label: "完成", primary: true, click: finish},
		})
	}()
}

func finish() {
	if doneOk && launchChecked {
		exe := filepath.Join(installDir, "DSH Desktop.exe")
		if _, err := os.Stat(exe); err == nil {
			cmd := exec.Command(exe)
			cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x00000008}
			_ = cmd.Start()
		}
	}
	procPostMessage.Call(hwnd, WM_CLOSE, 0, 0)
}

// setupWindow creates the installer window and every GDI surface. The
// surfaces must come from the WINDOW's device context (a screen-DC-compatible
// surface will NOT blit to the window and leaves it black).
func setupWindow(img image.Image) bool {
	hwnd = createWindow()
	if hwnd == 0 {
		fmt.Fprintln(os.Stderr, "failed to create the installer window")
		return false
	}
	wdc := getDC(hwnd)
	bgDIB = makeDib(wdc, img)
	bgDC = createCompatibleDC(wdc)
	procSelectObject.Call(bgDC, bgDIB)
	offDIB = makeDib(wdc, image.NewRGBA(image.Rect(0, 0, winW, winH)))
	offDC = createCompatibleDC(wdc)
	procSelectObject.Call(offDC, offDIB)
	releaseDC(hwnd, wdc)
	if bgDIB == 0 || offDIB == 0 {
		fmt.Fprintln(os.Stderr, "failed to build the background bitmap")
		return false
	}
	editBrush, _, _ = procCreateSolidBrush.Call(colEditBg)
	return true
}

// runWorkerMode is the self-update worker with a visible progress window:
// the built-in updater (electron/updater.mjs) downloads the new setup exe and
// runs it elevated with `--installer-worker <dir> [--relaunch]`. The overlay
// install takes tens of seconds (440 MB + warm-up), so it must NOT run
// silently — the user watches the same progress page as a fresh install, and
// on completion the app relaunches (--relaunch) and the window closes itself.
func runWorkerMode(target string, relaunch bool) {
	img, _, err := image.Decode(bytes.NewReader(bgPng))
	if err != nil {
		fmt.Fprintln(os.Stderr, "failed to decode the background:", err)
		return
	}
	if !setupWindow(img) {
		return
	}
	installDir = target
	progressHeading = "正在更新"
	doneHeading = "更新完成"
	statusText = "准备更新…"
	setPage(pageProgress, nil)
	procShowWindow.Call(hwnd, SW_SHOW)
	procUpdateWindow.Call(hwnd)
	go func() {
		err := installTo(target)
		if err != nil {
			doneOk = false
			doneText = "更新失败：" + err.Error()
			fmt.Fprintln(os.Stderr, "installer worker failed:", err)
			if log, openErr := os.OpenFile(`C:\dsh-desktop-install.log`, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644); openErr == nil {
				log.WriteString(time.Now().Format("2006-01-02 15:04:05") + " | error | worker: " + err.Error() + "\n")
				log.Close()
			}
			setPage(pageDone, []button{
				{x: 590, y: 386, w: 130, h: 44, label: "关闭", primary: true, click: func() {
					procPostMessage.Call(hwnd, WM_CLOSE, 0, 0)
				}},
			})
			return
		}
		doneOk = true
		doneText = "更新完成：" + target
		if relaunch {
			installedExe := filepath.Join(target, "DSH Desktop.exe")
			if _, statErr := os.Stat(installedExe); statErr == nil {
				hideConsole(exec.Command("explorer.exe", installedExe)).Start()
			}
		}
		// Let the user see the completion state before the window closes.
		time.Sleep(1200 * time.Millisecond)
		procPostMessage.Call(hwnd, WM_CLOSE, 0, 0)
	}()
	runMessageLoop()
}

func main() {
	runtime.LockOSThread()
	// `--dir <path>` marks the elevated handoff from startInstall: the window
	// opens straight into the progress page and installs to that directory.
	autoDir := ""
	// `--installer-worker <path> [--relaunch]` is the self-update worker:
	// the built-in updater runs the downloaded setup exe elevated with these
	// args; the worker shows a progress window, overlays the shell + runtime
	// onto the install directory, and (with --relaunch) starts the freshly
	// updated app through explorer.exe with the user's normal token.
	workerDir := ""
	workerRelaunch := false
	for i := 1; i < len(os.Args); i++ {
		switch os.Args[i] {
		case "--dir":
			if i+1 < len(os.Args) {
				autoDir = os.Args[i+1]
				i++
			}
		case "--installer-worker":
			if i+1 < len(os.Args) {
				workerDir = os.Args[i+1]
				i++
			}
		case "--relaunch":
			workerRelaunch = true
		}
	}
	if workerDir != "" {
		runWorkerMode(workerDir, workerRelaunch)
		return
	}
	// One installer window per session: a second launch activates the first.
	// The elevation handoff instance (--dir) retries briefly while the
	// original process releases the mutex and exits.
	if !acquireSingleInstance(autoDir != "") {
		activateExistingInstaller()
		return
	}
	if exePath, err := os.Executable(); err == nil {
		if _, _, shellTotal, runtimeTotal, err := readManifests(exePath); err == nil {
			installSizeBytes = shellTotal + runtimeTotal
		}
	}
	img, _, err := image.Decode(bytes.NewReader(bgPng))
	if err != nil {
		fmt.Fprintln(os.Stderr, "failed to decode the background:", err)
		return
	}

	if !setupWindow(img) {
		return
	}

	hInst, _, _ := procGetModuleHandleW.Call(0)
	editHwnd = createEditControl(hInst)
	if autoDir != "" {
		installDir = autoDir
		procSetWindowTextW.Call(editHwnd, uintptr(unsafe.Pointer(utf16Ptr(autoDir))))
	}
	showDirPage()
	procShowWindow.Call(hwnd, SW_SHOW)
	procUpdateWindow.Call(hwnd)
	if autoDir != "" {
		// Elevated handoff: jump straight into the install for the directory
		// the original instance had chosen.
		startInstall()
	}
	runMessageLoop()
}
