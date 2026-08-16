/**
 * Sync bundled community agent presets into `$DSH_HOME/.agent-presets`.
 *
 * These are the same directories the upstream projects install by hand:
 *   xiaobright/dsh-anchored-standard  →  anchored-standard
 *   yjh051108/dsh-routing-suite       →  router-standard
 *
 * Directories we previously installed carry a stamp file so later app
 * updates can refresh them. A same-id folder without the stamp is treated
 * as user-authored and left alone.
 */
import { existsSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const STAMP_NAME = '.dsh-desktop-bundled.json'
export const USER_PRESET_DIR = '.agent-presets'

export const BUNDLED_PRESETS = [
  {
    id: 'anchored-standard',
    dir: 'anchored-standard',
    source: 'github:xiaobright/dsh-anchored-standard',
    commit: '0398c5a018e9c9a7f109ff3d908291874a7563d2',
  },
  {
    id: 'router-standard',
    dir: 'router-standard',
    source: 'github:yjh051108/dsh-routing-suite',
    commit: 'a09eb0ade28e6ec3b8e5eb22985a14f6bfa1fbe5',
    presetCommit: 'eff787e95132d6c7104214542104a84d656b497e',
  },
]

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function copyDir(from, to) {
  mkdirSync(path.dirname(to), { recursive: true })
  cpSync(from, to, { recursive: true, force: true })
}

function writeStamp(dest, preset) {
  writeFileSync(path.join(dest, STAMP_NAME), JSON.stringify({
    id: preset.id,
    source: preset.source,
    commit: preset.commit,
    presetCommit: preset.presetCommit ?? null,
    bundledBy: 'dsh-desktop',
  }, null, 2) + '\n')
}

/**
 * Install bundled agent presets into `$DSH_HOME/.agent-presets`.
 * @param options.presetsRoot - electron/agent-presets
 * @param options.dshHome - $DSH_HOME
 * @param options.log - optional logger
 */
export function syncCompanionPresets({ presetsRoot, dshHome, log = () => {} }) {
  const userRoot = path.join(dshHome, USER_PRESET_DIR)
  mkdirSync(userRoot, { recursive: true })

  for (const preset of BUNDLED_PRESETS) {
    const src = path.join(presetsRoot, preset.dir)
    if (!existsSync(path.join(src, 'agent.cordis.yml'))) {
      log('skip missing preset ' + preset.id)
      continue
    }
    const dest = path.join(userRoot, preset.id)
    const stamp = path.join(dest, STAMP_NAME)
    if (existsSync(dest) && !existsSync(stamp)) {
      log('keep user preset ' + preset.id)
      continue
    }
    if (existsSync(dest)) rmSync(dest, { recursive: true, force: true })
    copyDir(src, dest)
    writeStamp(dest, preset)
    log('synced preset ' + preset.id)
  }
}
