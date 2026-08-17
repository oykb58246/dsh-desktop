import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseLatestYml, selectUpdateArtifact, compareVersions } from './update-manifest.mjs'

const sample = `
version: 0.1.5
files:
  - url: https://example.com/dsh-desktop-setup-x64.exe
    sha512: FULLHASH
    size: 536981055
path: dsh-desktop-setup-x64.exe
sha512: FULLHASH
releaseDate: '2026-08-17T00:00:00.000Z'
patches:
  - from: 0.1.4
    url: https://example.com/dsh-desktop-patch-0.1.4-0.1.5-x64.exe
    sha512: PATCHHASH
    size: 12345678
`.trim()

test('parseLatestYml keeps the full installer as the first url for old clients', () => {
  const parsed = parseLatestYml(sample)
  assert.equal(parsed.version, '0.1.5')
  assert.equal(parsed.fileUrl, 'https://example.com/dsh-desktop-setup-x64.exe')
  assert.equal(parsed.sha512, 'FULLHASH')
  assert.equal(parsed.size, 536981055)
  assert.equal(parsed.patches.length, 1)
  assert.equal(parsed.patches[0].from, '0.1.4')
  assert.equal(parsed.patches[0].size, 12345678)
})

test('selectUpdateArtifact prefers the matching incremental patch', () => {
  const latest = {
    version: '0.1.5',
    url: 'https://example.com/full.exe',
    sha512: 'FULLHASH',
    size: 536981055,
    patch: { from: '0.1.4', url: 'https://example.com/patch.exe', sha512: 'PATCHHASH', size: 12345678 },
  }
  const patch = selectUpdateArtifact(latest, '0.1.4', 'auto')
  assert.equal(patch.channel, 'patch')
  assert.equal(patch.size, 12345678)
  const full = selectUpdateArtifact(latest, '0.1.4', 'full')
  assert.equal(full.channel, 'full')
  assert.equal(full.size, 536981055)
  const skip = selectUpdateArtifact(latest, '0.1.2', 'auto')
  assert.equal(skip.channel, 'full')
})

test('compareVersions orders dotted releases', () => {
  assert.equal(compareVersions('0.1.4', '0.1.5'), -1)
  assert.equal(compareVersions('v0.1.5', '0.1.5'), 0)
})
