import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const target = path.join(
  root, 'node_modules', '.pnpm',
  'app-builder-lib@26.15.3_dmg_c5739d9600ac3f98a55503c35c5a46a9',
  'node_modules', 'app-builder-lib', 'templates', 'nsis', 'portable.nsi',
)

const source = await readFile(target, 'utf8')
let patched = source

// 1) Store compression: the installer embeds the payload uncompressed, so
//    extraction is pure file I/O (fast) and never zip-decompression.
if (!patched.includes('SetCompress off')) {
  patched = patched.replace(
    ['Section', '  !ifdef SPLASH_IMAGE', '    HideWindow', '  !endif'].join('\n'),
    ['Section', '  ; ---- DSH patch: store compression — installer grows, extraction is pure I/O ----', '  SetCompress off', '', '  !ifdef SPLASH_IMAGE', '    HideWindow', '  !endif'].join('\n'),
  )
}

// 2) Undo the older "reuse the previous extraction" patch. It blindly reuses
//    %TEMP%\dsh-desktop-installer, so a NEWER setup exe silently launched the
//    files of an OLDER extraction — stale builds, wrong icons. With store
//    compression re-extraction is cheap and always correct: extract fresh.
if (patched.includes('dshPortableRun:')) {
  patched = patched.replace(
    [
      '  StrCpy $INSTDIR "$PLUGINSDIR\\app"',
      '  !ifdef UNPACK_DIR_NAME',
      '    StrCpy $INSTDIR "$TEMP\\${UNPACK_DIR_NAME}"',
      '  !endif',
      '',
      '  ; ---- DSH patch: reuse the previous extraction to skip the slow re-extract ----',
      '  IfFileExists "$INSTDIR\\${PRODUCT_FILENAME}.exe" dshPortableRun',
      '',
      '  RMDir /r $INSTDIR',
      '  SetOutPath $INSTDIR',
    ].join('\n'),
    [
      '  StrCpy $INSTDIR "$PLUGINSDIR\\app"',
      '  !ifdef UNPACK_DIR_NAME',
      '    StrCpy $INSTDIR "$TEMP\\${UNPACK_DIR_NAME}"',
      '  !endif',
      '',
      '  RMDir /r $INSTDIR',
      '  SetOutPath $INSTDIR',
    ].join('\n'),
  )
  patched = patched.replace(
    '  dshPortableRun:\n  System::Call \'Kernel32::SetEnvironmentVariable(t, t)i ("PORTABLE_EXECUTABLE_DIR", "$EXEDIR").r0\'',
    '  System::Call \'Kernel32::SetEnvironmentVariable(t, t)i ("PORTABLE_EXECUTABLE_DIR", "$EXEDIR").r0\'',
  )
}

// 3) Undo "keep the extraction dir as a cache": restore the original cleanup
//    so a finished run removes its extraction instead of leaving stale files.
if (patched.includes('; ---- DSH patch: keep the extraction dir as a cache for the next launch ----')) {
  patched = patched.replace(
    '  ; ---- DSH patch: keep the extraction dir as a cache for the next launch ----\nSectionEnd',
    ['  SetOutPath $EXEDIR', '\tRMDir /r $INSTDIR', 'SectionEnd'].join('\n'),
  )
}

// 4) Keep the splash visible while the store-mode payload is extracted. The
//    stock template hides the window right after the splash, which reads as
//    "the installer flashed and vanished" while ~400 MB is copied to temp.
if (patched.includes('    HideWindow')) {
  patched = patched.replace(
    ['  !ifdef SPLASH_IMAGE', '    HideWindow', '  !endif'].join('\n'),
    ['  !ifdef SPLASH_IMAGE', '    ; ---- DSH patch: splash stays visible while extracting ----', '  !endif'].join('\n'),
  )
}

if (patched !== source) {
  await writeFile(target, patched)
  console.log('portable.nsi patched')
} else {
  console.log('portable.nsi patch already applied')
}
