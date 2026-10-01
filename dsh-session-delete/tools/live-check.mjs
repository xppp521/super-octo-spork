/**
 * Live checks against a running DSH host.
 *
 * Probe mode (no argument) sends the refusal cases only — nothing is deleted:
 *   node tools/live-check.mjs
 *
 * Delete mode drives one real deletion through the live route, printing the
 * on-disk effect around it:
 *   node tools/live-check.mjs <sessionId>
 *
 * Why Node and not PowerShell: this machine's shell is Windows PowerShell 5.1,
 * whose Invoke-WebRequest both lacks `-SkipHttpErrorCheck` and swallows the body
 * of a non-2xx response, so the handler's own error payload is invisible there.
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const base = process.env.DSH_BASE ?? 'http://127.0.0.1:19387'
const target = process.argv[2]
const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')

/** Paths a session owns on disk (mirrors the persistence layout). */
function artifacts(sessionId, cwd) {
  const key = cwd === undefined ? '_no-cwd' : `--${cwd.replace(/[\\/:]+/g, '-').replace(/^-+/, '')}--`
  return {
    dir: join(home, 'sessions', key, sessionId),
    cache: join(home, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
  }
}

async function post(rawBody, headers = {}) {
  const response = await fetch(`${base}/dsh-session-delete/delete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: rawBody
  })
  return { status: response.status, body: await response.text() }
}

const status = await fetch(`${base}/dsh-session-delete/status`)
console.log(`GET /status -> HTTP ${status.status} ${await status.text()}\n`)

if (target === undefined) {
  const cases = [
    ['空 body', ''],
    ['非法 JSON', '{oops'],
    ['缺少 sessionId', '{}'],
    ['路径穿越', JSON.stringify({ sessionId: '../../etc/passwd' })],
    ['保留名 .', JSON.stringify({ sessionId: '.' })],
    ['不存在的会话', JSON.stringify({ sessionId: 'session-live-check-nonexistent' })]
  ]
  for (const [label, body] of cases) {
    const result = await post(body)
    console.log(`${label.padEnd(18)} -> HTTP ${result.status}  ${result.body}`)
  }
  const crossOrigin = await post(JSON.stringify({ sessionId: 'session-x' }), { origin: 'http://evil.example' })
  console.log(`${'跨站 Origin'.padEnd(16)} -> HTTP ${crossOrigin.status}  ${crossOrigin.body}`)
  console.log('\n（以上均为拒绝路径，未删除任何东西）')
} else {
  const cwd = process.argv[3]
  const paths = artifacts(target, cwd)
  const before = { dir: existsSync(paths.dir), cache: existsSync(paths.cache) }
  console.log(`删除目标: ${target}`)
  console.log(`  删除前: dir=${before.dir} cache=${before.cache}`)
  const result = await post(JSON.stringify({ sessionId: target }))
  console.log(`  POST -> HTTP ${result.status}  ${result.body}`)
  console.log(`  删除后: dir=${existsSync(paths.dir)} cache=${existsSync(paths.cache)}`)
}
