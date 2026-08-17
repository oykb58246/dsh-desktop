import assert from 'node:assert/strict'
import { test } from 'node:test'
import { diffFileIndex, buildFileIndex } from './file-index.mjs'

test('diffFileIndex reports changed, added and removed files', () => {
  const previous = buildFileIndex('0.1.4', [
    { path: 'keep.exe', size: 4, sha256: 'aaa' },
    { path: 'gone.exe', size: 4, sha256: 'bbb' },
    { path: 'changed.exe', size: 4, sha256: 'old' },
  ], [
    { path: 'rt.js', size: 2, sha256: 'r1' },
  ])
  const current = buildFileIndex('0.1.5', [
    { path: 'keep.exe', size: 4, sha256: 'aaa' },
    { path: 'changed.exe', size: 5, sha256: 'new' },
    { path: 'added.exe', size: 1, sha256: 'ccc' },
  ], [
    { path: 'rt.js', size: 2, sha256: 'r1' },
  ])
  const diff = diffFileIndex(previous, current)
  assert.equal(diff.fromVersion, '0.1.4')
  assert.equal(diff.toVersion, '0.1.5')
  assert.deepEqual(new Set(diff.shellChanged), new Set(['changed.exe', 'added.exe']))
  assert.deepEqual(diff.removeShell, ['gone.exe'])
  assert.deepEqual(diff.runtimeChanged, [])
  assert.deepEqual(diff.removeRuntime, [])
})
