/** Shared latest.yml parsing and incremental/full artifact selection. */

export const SETUP_ARTIFACT = 'dsh-desktop-setup-x64.exe'

export function parseLatestYml(text) {
  const clean = String(text).replace(/^\uFEFF/, '')
  const grab = (regex) => {
    const match = regex.exec(clean)
    return match === null ? null : match[1].trim()
  }
  const version = grab(/^version:\s*([^\s#]+)/m)
  if (version === null) return null
  const fileUrl = grab(/^\s*-\s*url:\s*(\S+)/m) ?? grab(/^url:\s*(\S+)/m) ?? SETUP_ARTIFACT
  const sha512 = grab(/^\s*sha512:\s*(\S+)/m)
  const size = grab(/^\s*size:\s*(\d+)/m)
  const releaseDate = grab(/^releaseDate:\s*'?([^'\r\n]+)'?/m)
  const patches = []
  const patchIdx = clean.search(/^patches:\s*$/m)
  if (patchIdx >= 0) {
    const chunks = clean.slice(patchIdx).split(/^\s*-\s+from:/m).slice(1)
    for (const chunk of chunks) {
      const from = chunk.match(/^\s*(\S+)/)?.[1]
      const url = chunk.match(/^\s*url:\s*(\S+)/m)?.[1]
      const patchSha = chunk.match(/^\s*sha512:\s*(\S+)/m)?.[1] ?? null
      const patchSize = chunk.match(/^\s*size:\s*(\d+)/m)?.[1]
      if (from && url) {
        patches.push({
          from,
          url,
          sha512: patchSha,
          size: patchSize === undefined ? null : Number(patchSize),
        })
      }
    }
  }
  return {
    version,
    fileUrl,
    sha512,
    size: size === null ? null : Number(size),
    releaseDate: releaseDate === null ? null : releaseDate,
    patches,
  }
}

export function normalizeVersion(value) {
  return String(value ?? '').trim().replace(/^v/i, '')
}

/** Compare two dotted version strings numerically (ignores a leading `v`). */
export function compareVersions(a, b) {
  const left = normalizeVersion(a).split(/[.-]/)
  const right = normalizeVersion(b).split(/[.-]/)
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const x = left[index] ?? ''
    const y = right[index] ?? ''
    const nx = /^\d+$/.test(x) ? Number.parseInt(x, 10) : null
    const ny = /^\d+$/.test(y) ? Number.parseInt(y, 10) : null
    if (nx !== null && ny !== null) {
      if (nx !== ny) return nx < ny ? -1 : 1
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

/** Pick the incremental patch when the running version matches, else the full installer. */
export function selectUpdateArtifact(latest, currentVersion, mode = 'auto') {
  if (latest === null) return null
  const full = {
    channel: 'full',
    version: latest.version,
    url: latest.url,
    sha512: latest.sha512,
    size: latest.size,
    fileName: SETUP_ARTIFACT,
    patchFrom: null,
  }
  if (mode === 'full' || !latest.patch) return full
  if (compareVersions(latest.patch.from, currentVersion) !== 0) return full
  return {
    channel: 'patch',
    version: latest.version,
    url: latest.patch.url,
    sha512: latest.patch.sha512,
    size: latest.patch.size,
    fileName: latest.patch.fileName
      ?? `dsh-desktop-patch-${normalizeVersion(latest.patch.from)}-${normalizeVersion(latest.version)}-x64.exe`,
    patchFrom: latest.patch.from,
  }
}
