/**
 * Cross-check the path mirror against live data, read-only.
 *
 * The deletion is only correct if the directory this plugin computes is the
 * directory the persistence backend actually wrote. Two independent checks:
 *
 *  1. fixed cases — paths whose encoded directory names were observed on this
 *     machine before the plugin existed;
 *  2. live cases — every session in the real `$DSH_HOME/storages/
 *     session_projcache/sessions/*.json` names its `cwd`; that session's log
 *     directory must sit under exactly `projectKey(cwd)`.
 *
 * Nothing here writes: it only reads `$DSH_HOME` (override with DSH_HOME).
 * Run with: node test/path-mirror-check.mjs
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const { projectKey, encodeSegment } = await import('../lib/index.js')

const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const failures = []
const check = (label, condition, detail = '') => {
  if (condition) console.log(`ok   ${label}`)
  else {
    console.log(`FAIL ${label} ${detail}`)
    failures.push(label)
  }
}

console.log(`DSH home: ${home}\n`)
console.log('1) 固定用例（本机磁盘上实际观察到的目录名）')
{
  const cases = [
    ['D:\\deepseek', '--D-deepseek--'],
    ['C:\\Users\\lsy\\Documents\\deepseek-harness\\default-workspace', '--C-Users-lsy-Documents-deepseek-harness-default-workspace--']
  ]
  for (const [cwd, expected] of cases) {
    const actual = projectKey(cwd)
    check(`${cwd} -> ${expected}`, actual === expected, `got ${actual}`)
  }
}

console.log('\n2) 会话 ID 编码（不允许逃出所在目录）')
{
  check('普通 id 原样保留', encodeSegment('session-a1c49c61-35e3-42b2-a780-b4b6920baa0e') === 'session-a1c49c61-35e3-42b2-a780-b4b6920baa0e')
  check('"." 被转义', encodeSegment('.') === '~002E')
  check('".." 被转义', encodeSegment('..') === '~002E~002E')
  check('分隔符被转义', encodeSegment('a/b\\c') === 'a~002Fb~005Cc', encodeSegment('a/b\\c'))
}

console.log('\n3) 实时用例：真实 projcache 的 cwd 与真实日志目录名逐字比对')
const cacheDir = join(home, 'storages', 'session_projcache', 'sessions')
const sessionsRoot = join(home, 'sessions')
if (!existsSync(cacheDir) || !existsSync(sessionsRoot)) {
  console.log('   (跳过：本机没有 projcache 或 sessions 目录)')
} else {
  const projectDirs = readdirSync(sessionsRoot).filter((name) => {
    try {
      return statSync(join(sessionsRoot, name)).isDirectory()
    } catch {
      return false
    }
  })
  let compared = 0
  for (const file of readdirSync(cacheDir).filter((name) => name.endsWith('.json'))) {
    const sessionId = file.slice(0, -'.json'.length)
    let cwd
    try {
      cwd = JSON.parse(readFileSync(join(cacheDir, file), 'utf8'))?.record?.identity?.cwd
    } catch {
      cwd = undefined
    }
    if (typeof cwd !== 'string' || cwd === '') continue
    // Where does this session's directory actually live?
    const actualParent = projectDirs.find((name) => existsSync(join(sessionsRoot, name, sessionId)))
    if (actualParent === undefined) continue
    compared += 1
    const expected = projectKey(cwd)
    check(`${sessionId}: ${cwd} -> ${expected}`, actualParent === expected, `磁盘上是 ${actualParent}`)
    check(`  目录段 ${basename(join(sessionsRoot, actualParent, sessionId))} == encodeSegment(id)`,
      basename(join(sessionsRoot, actualParent, sessionId)) === encodeSegment(sessionId))
    check(`  父目录就是 sessions 根下的直接子目录 (${dirname(join(sessionsRoot, actualParent, sessionId))})`,
      dirname(join(sessionsRoot, actualParent, sessionId)) === join(sessionsRoot, actualParent))
  }
  console.log(`   共比对 ${compared} 个真实会话`)
  if (compared === 0) console.log('   (本机当前没有可比的会话目录)')
}

console.log(failures.length === 0 ? '\n全部通过 ✅' : `\n失败 ${failures.length} 项 ❌`)
process.exit(failures.length === 0 ? 0 : 1)
