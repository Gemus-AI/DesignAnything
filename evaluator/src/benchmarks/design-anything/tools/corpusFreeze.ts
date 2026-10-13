/** 题包内容锁：冻结输入、题面、判据及审计证据；展示页与运行成绩不属于题库内容。 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const LOCK_FILE = 'freeze.json'
const CONTENT_DIRECTORIES = ['assets', 'scenarios', 'tasks', 'closure']
const CONTENT_FILES = ['manifest.json', 'changes.json', 'visual-revision.json', 'family-mapping.json']

interface FrozenFile { path: string; sha256: string }
export interface CorpusFreeze {
  schemaVersion: 1
  status: 'frozen'
  version: string
  frozenAt: string
  scope: 'authoring-content'
  taskCount: number
  fileCount: number
  contentSha256: string
  files: FrozenFile[]
}

function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function collectFiles(root: string): FrozenFile[] {
  const files: string[] = []
  const walk = (relative: string): void => {
    for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const file = `${relative}/${entry.name}`
      if (entry.isSymbolicLink()) throw new Error(`Corpus inventory cannot follow symlinks: ${file}`)
      if (entry.isDirectory()) walk(file)
      else if (entry.isFile()) files.push(file)
    }
  }
  for (const directory of CONTENT_DIRECTORIES) walk(directory)
  for (const file of CONTENT_FILES) {
    if (!existsSync(path.join(root, file))) throw new Error(`Missing corpus content: ${file}`)
    files.push(file)
  }
  return files.sort().map(file => ({ path: file, sha256: digest(readFileSync(path.join(root, file))) }))
}

export function assertCorpusNotFrozen(root: string): void {
  if (existsSync(path.join(root, LOCK_FILE))) {
    throw new Error(`Corpus is frozen: ${root}. Create a new corpus version for content changes.`)
  }
}

export function verifyCorpusFreeze(root: string): CorpusFreeze | undefined {
  const file = path.join(root, LOCK_FILE)
  if (!existsSync(file)) return undefined
  const record = JSON.parse(readFileSync(file, 'utf8')) as CorpusFreeze
  if (record.schemaVersion !== 1 || record.status !== 'frozen' || record.scope !== 'authoring-content'
    || record.version !== path.basename(root) || !Number.isInteger(record.taskCount) || record.taskCount < 1
    || !Array.isArray(record.files) || !record.files.length || record.fileCount !== record.files.length
    || record.contentSha256 !== digest(JSON.stringify(record.files))) {
    throw new Error('Invalid corpus freeze record')
  }
  const actual = collectFiles(root)
  if (record.taskCount !== actual.filter(item => /^tasks\/[^/]+\.json$/.test(item.path)).length) {
    throw new Error('Frozen corpus task count differs')
  }
  if (JSON.stringify(actual) !== JSON.stringify(record.files)) {
    const before = new Map(record.files.map(item => [item.path, item.sha256]))
    const after = new Map(actual.map(item => [item.path, item.sha256]))
    const changed = [...new Set([...before.keys(), ...after.keys()])].filter(key => before.get(key) !== after.get(key))
    throw new Error(`Frozen corpus content changed: ${changed.join(', ')}`)
  }
  return record
}

/** 由完整题库验收入口在校验通过后调用；wx 防止覆盖既有冻结记录。 */
export function freezeCorpus(root: string, taskCount: number): CorpusFreeze {
  assertCorpusNotFrozen(root)
  const files = collectFiles(root)
  if (!Number.isInteger(taskCount) || taskCount < 1
    || files.filter(item => /^tasks\/[^/]+\.json$/.test(item.path)).length !== taskCount) {
    throw new Error('Cannot freeze an empty or mismatched task corpus')
  }
  const record: CorpusFreeze = {
    schemaVersion: 1, status: 'frozen', version: path.basename(root), frozenAt: new Date().toISOString(),
    scope: 'authoring-content', taskCount, fileCount: files.length,
    contentSha256: digest(JSON.stringify(files)), files,
  }
  writeFileSync(path.join(root, LOCK_FILE), `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' })
  return record
}
