/**
 * Pre-flight smoke test for the host half, run outside DSH.
 *
 * Builds a throwaway DSH home, fakes the three host services the route reads
 * (`sessions`, `sessionPersistence`, `workspaceRegistry`), drives the real
 * registered HTTP handler, and asserts the on-disk effect. Run with:
 *   node test/host-smoke.mjs
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = join(tmpdir(), `dsh-session-delete-smoke-${process.pid}`)
rmSync(home, { recursive: true, force: true })
process.env.DSH_HOME = home

const CWD = 'D:\\deepseek'
const SESSION = 'session-smoke-1'
const PROJECT_KEY = '--D-deepseek--'

const failures = []
const check = (label, condition, detail = '') => {
  if (condition) console.log(`  ok   ${label}`)
  else {
    console.log(`  FAIL ${label} ${detail}`)
    failures.push(label)
  }
}

/** cwd of every session this run seeded, keyed by id: the fake persistence reads it. */
const seededCwd = new Map()

/** Create the durable fixtures for one session. */
function seedSession(id, cwd, projectKey) {
  const dir = join(home, 'sessions', projectKey, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), Buffer.from('fake-zstd-log'))
  const cacheDir = join(home, 'storages', 'session_projcache', 'sessions')
  mkdirSync(cacheDir, { recursive: true })
  writeFileSync(join(cacheDir, `${id}.json`), JSON.stringify({ version: 7, record: { identity: { cwd } } }))
  seededCwd.set(id, cwd)
  return { dir, cache: join(cacheDir, `${id}.json`) }
}

const { apply } = await import('../lib/index.js')

const routes = []
const registryCalls = []
/** Remote events this plugin emitted, as [name, sessionId] pairs. */
const emitted = []
/** Sessions the host merely has LOADED (opened in the UI). Must not block deletion. */
let loadedSessions = new Set()
/** Activity the product's own waterfall reports, per session id. Blocks deletion. */
let activityBySession = new Map()
/** Agents the registry reports as `status === 'running'`. Also blocks deletion. */
let runningAgents = new Set()

const services = {
  sessions: { get: (id) => (loadedSessions.has(id) ? { id } : undefined) },
  agents: { list: () => [...runningAgents].map((id) => ({ id, status: 'running' })) },
  sessionPersistence: {
    root: join(home, 'sessions'),
    stat: async (id) => (seededCwd.has(id) ? { header: { id, cwd: seededCwd.get(id) } } : undefined)
  },
  workspaceRegistry: {
    list: () => [{
      id: 'ws-1',
      title: 'deepseek',
      sessionIds: [SESSION],
      detachSession: async (id) => { registryCalls.push(`detach:${id}`) }
    }],
    unarchiveSession: async (id) => { registryCalls.push(`unarchive:${id}`) },
    unpinSession: async (id) => { registryCalls.push(`unpin:${id}`) }
  }
}

/** The product's activity waterfall, as the workspace registry dispatches it. */
const waterfall = async (event, payload, fallback) => {
  if (event !== 'workspace/session-activity') return typeof fallback === 'function' ? fallback() : undefined
  const entries = activityBySession.get(payload?.sessionId) ?? []
  if (entries.length === 0) return typeof fallback === 'function' ? fallback() : []
  return entries
}

const hostCtx = {
  get: (name) => services[name],
  logger: { info: () => {}, warn: (message) => console.log(`  host-warn: ${message}`) },
  effect: (callback) => { callback() },
  waterfall,
  /** The product's own cross-plugin relay: the session controller emits this on dispose. */
  emit: (name, sessionId) => { emitted.push([name, sessionId]) },
  webServer: {
    register: (route) => {
      routes.push(route)
      return () => {}
    }
  }
}
const ctx = {
  get: hostCtx.get,
  logger: hostCtx.logger,
  waterfall,
  emit: hostCtx.emit,
  inject: (names, callback) => { callback(hostCtx) }
}

apply(ctx)
check('两个路由已注册', routes.length === 2, `got ${routes.length}`)
const route = routes.find((item) => item.path === '/dsh-session-delete/delete')
check('删除路由存在', route !== undefined)

/** Drive the real handler. */
async function call(body, overrides = {}) {
  const payload = JSON.stringify(body)
  const request = {
    method: overrides.method ?? 'POST',
    headers: { host: '127.0.0.1:19387', origin: 'http://127.0.0.1:19387', ...(overrides.headers ?? {}) },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(payload)
    }
  }
  const response = {
    statusCode: 0,
    body: '',
    writeHead(code) { this.statusCode = code },
    end(chunk) { if (chunk) this.body += chunk }
  }
  await route.handler(request, response)
  let json = null
  try { json = JSON.parse(response.body) } catch { json = null }
  return { status: response.statusCode, json }
}

console.log('\n1) 无效 ID 被拒绝')
{
  for (const bad of ['../../etc/passwd', '.', '..', 'a/b', 'a\\b', '', 'x'.repeat(201)]) {
    const result = await call({ sessionId: bad })
    check(`400 + invalid-id: ${JSON.stringify(bad.slice(0, 20))}`, result.status === 400 && result.json?.code === 'invalid-id', JSON.stringify(result))
  }
}

console.log('\n2) 有活动在跑 → 拒绝（产品的 workspace/session-activity 说了算）')
{
  activityBySession = new Map([[SESSION, [{ kind: 'turn', items: [{ id: SESSION }] }]]])
  const result = await call({ sessionId: SESSION })
  check('409 + session-live', result.status === 409 && result.json?.code === 'session-live', JSON.stringify(result))
  check('回报活动种类', Array.isArray(result.json?.activity) && result.json.activity.includes('turn'), JSON.stringify(result.json?.activity))
  activityBySession = new Map()
}

console.log('\n2b) agent 状态 running → 拒绝')
{
  runningAgents = new Set([SESSION])
  const result = await call({ sessionId: SESSION })
  check('409 + session-live', result.status === 409 && result.json?.code === 'session-live', JSON.stringify(result))
  runningAgents = new Set()
}

console.log('\n2c) 仅被宿主加载（空闲）→ 允许删除（这就是线上报的那个 bug）')
{
  loadedSessions = new Set([SESSION])
  const { dir, cache } = seedSession(SESSION, CWD, PROJECT_KEY)
  const result = await call({ sessionId: SESSION })
  check('200 而不是 409', result.status === 200 && result.json?.ok === true, JSON.stringify(result))
  check('回报 loaded=true', result.json?.loaded === true, JSON.stringify(result.json?.loaded))
  check('文件确实被删掉', !existsSync(dir) && !existsSync(cache))
  loadedSessions = new Set()
}

console.log('\n3) 找不到的会话返回 404')
{
  const result = await call({ sessionId: 'session-does-not-exist' })
  check('404 + not-found', result.status === 404 && result.json?.code === 'not-found', JSON.stringify(result))
}

console.log('\n4) 正常删除：文件、缓存、注册表登记都清掉，并通知客户端丢行')
{
  emitted.length = 0
  const { dir, cache } = seedSession(SESSION, CWD, PROJECT_KEY)
  check('前置：日志目录存在', existsSync(dir))
  check('前置：projcache 存在', existsSync(cache))
  const result = await call({ sessionId: SESSION })
  check('200 ok', result.status === 200 && result.json?.ok === true, JSON.stringify(result))
  check('日志目录已删除', !existsSync(dir))
  check('projcache 已删除', !existsSync(cache))
  check('注册表已摘除', registryCalls.includes(`detach:${SESSION}`), JSON.stringify(registryCalls))
  check('归档/置顶集合也清理', registryCalls.includes(`unarchive:${SESSION}`) && registryCalls.includes(`unpin:${SESSION}`))
  check('返回了被删路径', result.json?.removed?.logDirectory === dir)
  check(
    '发出了 api-session/removed（客户端据此丢行）',
    emitted.some(([name, id]) => name === 'api-session/removed' && id === SESSION),
    JSON.stringify(emitted)
  )
  check('响应回报 notified=true', result.json?.notified === true)
}

console.log('\n4b) 裸 UUID ID（真实机器上的子代理会话就是这种，没有 session- 前缀）')
{
  const uuidId = '37cbb72e-d7c1-4cc4-9786-a03d64cc34a2'
  const { dir, cache } = seedSession(uuidId, CWD, PROJECT_KEY)
  const result = await call({ sessionId: uuidId })
  check('200 ok（ID 格式不再被误拒）', result.status === 200 && result.json?.ok === true, JSON.stringify(result))
  check('日志目录已删除', !existsSync(dir))
  check('projcache 已删除', !existsSync(cache))
}

console.log('\n5) 跨站请求被拒绝')
{
  const result = await call({ sessionId: SESSION }, { headers: { origin: 'http://evil.example' } })
  check('403 + cross-origin', result.status === 403 && result.json?.code === 'cross-origin', JSON.stringify(result))
}

console.log('\n6) GET 不被接受')
{
  const result = await call({ sessionId: SESSION }, { method: 'GET' })
  check('405', result.status === 405, JSON.stringify(result))
}

rmSync(home, { recursive: true, force: true })
console.log(failures.length === 0 ? '\n全部通过 ✅' : `\n失败 ${failures.length} 项 ❌`)
process.exit(failures.length === 0 ? 0 : 1)
