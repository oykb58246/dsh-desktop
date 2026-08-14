import path from 'node:path'
import { readdir, stat } from 'node:fs/promises'

const MAX_SCAN_DEPTH = 5
const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.hg',
  '.svn',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.parcel-cache',
  '.vite',
  '.output',
  'node_modules',
  'dist',
  'build',
  'build-output',
  'fast-output',
  'out',
  'output',
  'target',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
])

const PROJECT_MARKERS = new Set([
  'package.json',
  'Cargo.toml',
  'pyproject.toml',
  'requirements.txt',
  'Pipfile',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'composer.json',
  'CMakeLists.txt',
  'Makefile',
])

const PROJECT_EXTENSIONS = new Set([
  '.csproj',
  '.fsproj',
  '.sln',
  '.xcodeproj',
  '.xcworkspace',
])

function isProjectMarker(name) {
  return PROJECT_MARKERS.has(name) || [...PROJECT_EXTENSIONS].some((extension) => name.endsWith(extension))
}

function normalizeRoot(rootPath) {
  if (typeof rootPath !== 'string' || rootPath.trim() === '') {
    throw new Error('请选择一个 Codex 工作区目录')
  }
  return path.resolve(rootPath.trim())
}

function createCandidate(directoryPath, relativePath, markerNames) {
  return {
    name: path.basename(directoryPath) || directoryPath,
    relativePath: relativePath || '.',
    absolutePath: directoryPath,
    files: 0,
    sizeBytes: 0,
    markers: markerNames,
  }
}

async function walkDirectory(directoryPath, relativePath, depth, projects) {
  let entries
  try {
    entries = await readdir(directoryPath, { withFileTypes: true })
  } catch {
    return
  }

  const markerNames = entries
    .filter((entry) => entry.isFile() && isProjectMarker(entry.name))
    .map((entry) => entry.name)
  let files = 0
  let sizeBytes = 0

  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name)
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name) || depth >= MAX_SCAN_DEPTH) continue
      const childStats = await walkDirectory(
        entryPath,
        path.join(relativePath, entry.name),
        depth + 1,
        projects,
      )
      files += childStats.files
      sizeBytes += childStats.sizeBytes
      continue
    }

    if (!entry.isFile()) continue
    let fileSize = 0
    try {
      fileSize = (await stat(entryPath)).size
    } catch {
      continue
    }
    files += 1
    sizeBytes += fileSize
  }

  if (markerNames.length > 0) {
    const project = createCandidate(directoryPath, relativePath, markerNames)
    project.files = files
    project.sizeBytes = sizeBytes
    projects.push(project)
  }

  return { files, sizeBytes }
}

export async function scanCodexProjects(rootPath) {
  const absoluteRoot = normalizeRoot(rootPath)
  const rootStats = await stat(absoluteRoot)
  if (!rootStats.isDirectory()) throw new Error('选择的路径不是目录')

  const projects = []
  await walkDirectory(absoluteRoot, '', 0, projects)

  projects.sort((left, right) => {
    const pathOrder = left.relativePath.localeCompare(right.relativePath, undefined, { sensitivity: 'base' })
    return pathOrder || left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
  })

  return {
    rootPath: absoluteRoot,
    scannedAt: new Date().toISOString(),
    maxDepth: MAX_SCAN_DEPTH,
    projects: projects.map(({ absolutePath, ...project }) => ({
      ...project,
      absolutePath,
      status: project.markers.length > 0 ? 'ready' : 'needs-confirmation',
    })),
  }
}
