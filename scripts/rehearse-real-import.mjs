// Real-environment rehearsal v2: scan the real Codex workspace, pick the
// "deepseek-harness" project, copy it into the harness target root, import its
// matching rollouts as dsh sessions, register the workspace.
import {
  copyProjects,
  findProjectRollouts,
  importSessionFromRollout,
  precheckImport,
} from '../electron/codex-import.mjs'
import { scanCodexProjects } from '../electron/codex-projects.mjs'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'

const dshHome = process.env.DSH_HOME
if (!dshHome) throw new Error('DSH_HOME must be set explicitly')
const targetRoot = 'D:\\jzz\\tool\\dsh-desktop\\output\\harness-projects'
const workspaceRoot = 'C:\\Users\\17367\\Documents\\Codex'

await mkdir(targetRoot, { recursive: true })

// 1. scan + pick the deepseek-harness project (270 files, real content)
const scan = await scanCodexProjects(workspaceRoot)
const project = scan.projects.find((p) => p.name === 'deepseek-harness' && p.relativePath.startsWith('2026-08-13'))
if (!project) throw new Error('deepseek-harness project not found in scan')
console.log('picked:', project.name, project.absolutePath, `${project.files} files`)

// 2. precheck
const precheck = await precheckImport(targetRoot, [project], dshHome)
for (const row of precheck.reports) {
  console.log('precheck:', row.name, 'targetExists=', row.targetExists, 'rollouts=', row.sessions.length)
}

// 3. copy with progress
const copyResults = await copyProjects(targetRoot, [project], (p) => {
  if (p.done % 50 === 0 || p.done === p.total) console.log(`copy ${p.name}: ${p.done}/${p.total}`)
})
const targetPath = copyResults[0].targetPath
console.log('copied to:', targetPath)

// 4. import matching sessions
const rollouts = precheck.reports[0].sessions
console.log('importing', rollouts.length, 'sessions')
const written = []
const skipped = []
for (const rollout of rollouts) {
  try {
    const outcome = await importSessionFromRollout({
      rollout: rollout.file,
      cwd: targetPath,
      sessionId: rollout.id || undefined,
      dshHome,
    })
    written.push(outcome)
    console.log('written:', outcome.sessionId, `(${outcome.events} events)`, '@', outcome.logPath)
  } catch (error) {
    skipped.push({ id: rollout.id ?? rollout.file, error: error.message })
    console.log('skipped:', rollout.id, error.message)
  }
}
console.log('session import: written', written.length, 'skipped', skipped.length)
