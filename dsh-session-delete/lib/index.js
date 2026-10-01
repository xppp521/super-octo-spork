/**
 * dsh-session-delete — host half.
 *
 * The only job of this half is to make a real, irreversible deletion of one
 * stored Session available to the browser at one exact HTTP route. The browser
 * half (`client/client.js`) contributes the sidebar menu row / hover button and
 * the confirmation dialog; it never touches the filesystem itself.
 *
 * Why a filesystem deletion exists at all: DSH deliberately ships no Session
 * deletion — sessions can be archived but never removed, the persistence seam
 * has no delete interface, and `session/delete` exists only in the Agent
 * protocol DSH speaks as a *client*. This plugin is therefore an opt-in
 * extension that removes exactly what the product keeps:
 *
 *   1. `<sessionsRoot>/<projectKey(cwd)>/<encodeSegment(id)>/`  — the log
 *   2. `<dshHome>/storages/session_projcache/sessions/<id>.json` — list metadata
 *   3. the Workspace registry's account for that id (membership, archive, pin)
 *
 * Everything is deliberately written against plain Node built-ins: a plugin
 * installed outside the shipped composition cannot resolve `@deepseek-ai/*`
 * packages, so every harness fact it needs is taken from live services
 * (`sessionPersistence`, `sessions`, `workspaceRegistry`) at request time.
 *
 * @module dsh-session-delete
 */
import { existsSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'

/** Cordis plugin identity. */
export const name = 'dsh-session-delete'

/** The deletion route the client posts to. */
const DELETE_PATH = '/dsh-session-delete/delete'
/** A read-only health route, used to verify the host half loaded. */
const STATUS_PATH = '/dsh-session-delete/status'
/**
 * Session ids are opaque strings: the store mints `session-<n>` / `session-<uuid>`
 * for ordinary conversations, but a caller may pass any explicit id — subagent
 * sessions on this machine use a bare uuid with no prefix. So this refuses only
 * what could actually matter (empty, over-long, or containing path separators)
 * plus the two names meaning "this directory" and "the parent directory".
 *
 * It is NOT the safety boundary: the directory name comes from `encodeSegment`,
 * which escapes separators, `~`, and dots, so no accepted id can escape its
 * project directory. This check exists so a malformed request is refused before
 * any path is built at all.
 */
const SESSION_ID_RE = /^[A-Za-z0-9._~-]{1,200}$/
/** Names that would address a directory rather than a child of one. */
const SESSION_ID_RESERVED = new Set(['.', '..'])
/** A delete request is one small JSON object. */
const MAX_BODY_BYTES = 64 * 1024

/**
 * The harness home: an explicit `$DSH_HOME`, else `<os home>/.dsh`.
 * Mirrors `@deepseek-ai/dsh-home-paths` resolution without importing it.
 * @returns the absolute harness home.
 */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return resolve(fromEnv.trim())
  return join(homedir(), '.dsh')
}

/**
 * The readable project directory name for one `cwd`, byte-for-byte identical to
 * the jsonl persistence backend's `projectKey`: path separators collapse into a
 * single `-`, allowed characters survive, everything else becomes `~XXXX`, the
 * result is wrapped in `--…--` and bounded for filesystem limits.
 *
 * Exported for `test/path-mirror-check.mjs`, which asserts it against the real
 * directory names found under a live `$DSH_HOME/sessions`.
 * @param cwd - the session's project directory.
 * @returns one filesystem-safe directory name.
 */
export function projectKey(cwd) {
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i += 1) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/**
 * Encode one path segment the way the persistence backend does, so a session id
 * can never escape the directory it is joined onto.
 * Exported for `test/path-mirror-check.mjs`.
 * @param raw - the raw segment.
 * @returns the encoded segment.
 */
export function encodeSegment(raw) {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

/**
 * Write one JSON response.
 * @param response - the Node response.
 * @param status - HTTP status code.
 * @param payload - JSON-serializable body.
 */
function sendJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

/**
 * Read and parse one small JSON request body.
 * @param request - the Node request.
 * @returns the parsed body.
 * @throws when the body is oversized or not JSON.
 */
async function readJsonBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  return JSON.parse(text)
}

/**
 * Accept only same-origin callers. A browser fetch from the DSH page always
 * carries `Origin`; a missing one (curl, tests) is allowed.
 * @param request - the Node request.
 * @returns whether the caller may mutate state.
 */
function sameOrigin(request) {
  const origin = request.headers.origin
  if (typeof origin !== 'string' || origin === '') return true
  try {
    return new URL(origin).host === request.headers.host
  } catch {
    return false
  }
}

/**
 * Remove one session from the Workspace registry's accounting. Membership,
 * archive, and pin are all idempotent by design, so every call is safe on a
 * session that was never accounted or never archived/pinned; failures here are
 * reported but never undo the file deletion that already succeeded.
 * @param ctx - the host context.
 * @param sessionId - the session to forget.
 * @returns the registry operations that ran, for the response payload.
 */
async function forgetInRegistry(ctx, sessionId) {
  const done = []
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined || registry === null) return done
  const workspaces = typeof registry.list === 'function' ? registry.list() : []
  for (const workspace of workspaces) {
    if (typeof workspace?.detachSession !== 'function') continue
    if (Array.isArray(workspace.sessionIds) && !workspace.sessionIds.includes(sessionId)) continue
    await workspace.detachSession(sessionId)
    done.push(`detach:${workspace.id ?? workspace.title ?? '?'}`)
  }
  if (typeof registry.unarchiveSession === 'function') {
    await registry.unarchiveSession(sessionId)
    done.push('unarchive')
  }
  if (typeof registry.unpinSession === 'function') {
    await registry.unpinSession(sessionId)
    done.push('unpin')
  }
  return done
}

/**
 * Is real work in flight for this session?
 *
 * Two independent, authoritative signals — deliberately NOT "is the session in
 * the in-memory store". That store also holds sessions which are merely
 * loaded/opened by the UI, and using it as the liveness test made an idle
 * session undeletable (reported live).
 *
 *  1. `workspace/session-activity`: the product's own admission — the very
 *     waterfall the built-in Archive action asks. Whatever the product counts as
 *     active work (a turn, subagents, background jobs, scheduled reminders)
 *     refuses deletion too.
 *  2. the agent registry: an agent whose `status` is exactly `running`.
 *
 * Fail-open by design: a composition without activity providers must not make
 * deletion impossible. The caller separately reports whether the session was
 * loaded, so the response can say why the in-memory copy is unaffected.
 *
 * @param ctx - the host context.
 * @param sessionId - the session to inspect.
 * @returns the activity kinds that block deletion (empty when nothing runs).
 */
async function sessionActivity(ctx, sessionId) {
  const kinds = []
  try {
    const waterfall = ctx.waterfall
    if (typeof waterfall === 'function') {
      const reported = await waterfall.call(ctx, 'workspace/session-activity', { sessionId }, () => Promise.resolve([]))
      for (const entry of Array.isArray(reported) ? reported : []) {
        const kind = typeof entry?.kind === 'string' && entry.kind !== '' ? entry.kind : 'activity'
        if (!kinds.includes(kind)) kinds.push(kind)
      }
    }
  } catch (error) {
    // A throwing provider is not evidence of work; the agent check still runs.
  }
  try {
    const agents = ctx.get('agents')
    const listed = typeof agents?.list === 'function' ? agents.list() : []
    for (const agent of Array.isArray(listed) ? listed : []) {
      if (agent?.id === sessionId && agent.status === 'running') {
        if (!kinds.includes('turn')) kinds.push('turn')
        break
      }
    }
  } catch (error) {
    // An unreachable inventory is likewise not evidence of work.
  }
  return kinds
}

/**
 * Delete one session's durable artifacts and registry account.
 * @param ctx - the host context.
 * @param rawId - the requested session id, untrusted.
 * @returns `{ status, body }` for the HTTP response.
 */
async function deleteSession(ctx, rawId) {
  if (typeof rawId !== 'string' || !SESSION_ID_RE.test(rawId) || SESSION_ID_RESERVED.has(rawId)) {
    return { status: 400, body: { ok: false, code: 'invalid-id', error: '无效的会话 ID。' } }
  }
  const sessionId = rawId

  // 1. Refuse only when work is actually in flight. `sessions.get()` answers
  //    "does the host have this session loaded", which is not the same question:
  //    an idle session the UI merely opened is loaded, and refusing it made the
  //    entry look broken.
  const activity = await sessionActivity(ctx, sessionId)
  if (activity.length > 0) {
    return {
      status: 409,
      body: {
        ok: false,
        code: 'session-live',
        activity,
        error: `这个会话还有正在进行的工作（${activity.join('、')}），无法删除。请先停止它或等它结束，再试一次。`,
      },
    }
  }
  // Loaded-but-idle is allowed. Report it: the files are gone immediately, but
  // the host's in-memory copy stays until the sidebar list refreshes.
  const sessions = ctx.get('sessions')
  const loaded = typeof sessions?.get === 'function' && sessions.get(sessionId) !== undefined

  // 2. Resolve the stored header: it carries the `cwd` the directory key needs,
  //    and its absence is what "no such session" means.
  const persistence = ctx.get('sessionPersistence')
  let stored
  try {
    stored = await persistence?.stat?.(sessionId)
  } catch (error) {
    return {
      status: 500,
      body: { ok: false, code: 'stat-failed', error: `无法读取会话记录：${error instanceof Error ? error.message : String(error)}` },
    }
  }
  if (stored === undefined || stored === null) {
    return { status: 404, body: { ok: false, code: 'not-found', error: '找不到这个会话，它可能已经被删除。' } }
  }
  const cwd = stored?.header?.cwd

  // 3. Compute the two paths, with a hard guard that the log directory stays
  //    inside the sessions root.
  const root = resolve(typeof persistence?.root === 'string' ? persistence.root : join(dshHome(), 'sessions'))
  const dir = cwd === undefined
    ? join(root, '_no-cwd', encodeSegment(sessionId))
    : join(root, projectKey(cwd), encodeSegment(sessionId))
  if (resolve(dir) !== root && !resolve(dir).startsWith(root + sep)) {
    return { status: 500, body: { ok: false, code: 'unsafe-path', error: '内部错误：解析出的会话目录不在会话根目录内，已中止。' } }
  }
  const cachePath = join(dshHome(), 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)

  // 4. Remove the artifacts. The log directory is removed recursively; the
  //    metadata cache is one file.
  const removed = { logDirectory: null, projectionCache: null }
  const warnings = []
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true })
    removed.logDirectory = dir
  }
  if (existsSync(cachePath)) {
    rmSync(cachePath, { force: true })
    removed.projectionCache = cachePath
  }

  // 5. Forget the registry account so the sidebar cannot keep a ghost row.
  let registryOps = []
  try {
    registryOps = await forgetInRegistry(ctx, sessionId)
  } catch (error) {
    warnings.push(`注册表清理失败：${error instanceof Error ? error.message : String(error)}`)
  }

  // 6. Tell every connected client to drop the row. `api-session/removed` is the
  //    declared remote event (@deepseek-ai/dsh-api-remotes) that the session
  //    controller itself emits when a host session is disposed, and the browser
  //    half applies it through the same handler. The durable record this row was
  //    built from is gone, so the event states exactly what is now true. Without
  //    it the row lingers — the host still holds a loaded copy — and shows up
  //    under "未分组" once the registry account is gone.
  let notified = false
  try {
    if (typeof ctx.emit === 'function') {
      ctx.emit('api-session/removed', sessionId)
      notified = true
    }
  } catch (error) {
    warnings.push(`通知客户端移除失败：${error instanceof Error ? error.message : String(error)}`)
  }

  return {
    status: 200,
    body: {
      ok: true,
      sessionId,
      displayTitle: stored?.header?.title ?? null,
      loaded,
      notified,
      removed,
      registryOps,
      warnings,
    },
  }
}

/**
 * Compose the plugin: one exact route on the web server, torn down with the
 * fiber that owns it.
 * @param ctx - the host context.
 */
export function apply(ctx) {
  ctx.inject(['webServer'], (hostCtx) => {
    hostCtx.effect(() => {
      const disposeDelete = hostCtx.webServer.register({
        kind: 'exact',
        path: DELETE_PATH,
        handler: async (request, response) => {
          if (request.method !== 'POST') {
            response.writeHead(405, { allow: 'POST' })
            response.end()
            return
          }
          if (!sameOrigin(request)) {
            sendJson(response, 403, { ok: false, code: 'cross-origin', error: '拒绝跨站请求。' })
            return
          }
          let body
          try {
            body = await readJsonBody(request)
          } catch (error) {
            sendJson(response, 400, { ok: false, code: 'bad-body', error: error instanceof Error ? error.message : String(error) })
            return
          }
          try {
            const result = await deleteSession(hostCtx, body?.sessionId)
            if (!result.body.ok) hostCtx.logger?.warn?.(`dsh-session-delete: ${result.body.code} (${String(body?.sessionId)})`)
            else hostCtx.logger?.info?.(`dsh-session-delete: deleted ${result.body.sessionId}`)
            sendJson(response, result.status, result.body)
          } catch (error) {
            hostCtx.logger?.warn?.(`dsh-session-delete: delete failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
            sendJson(response, 500, { ok: false, code: 'failed', error: error instanceof Error ? error.message : String(error) })
          }
        },
      })
      const disposeStatus = hostCtx.webServer.register({
        kind: 'exact',
        path: STATUS_PATH,
        handler: (request, response) => {
          if (request.method !== 'GET') {
            response.writeHead(405, { allow: 'GET' })
            response.end()
            return
          }
          sendJson(response, 200, {
            ok: true,
            // Bumped whenever this half changes, so a remote caller can tell
            // whether a running host picked the change up without a restart.
            revision: 4,
            plugin: name,
            sessionsRoot: (() => {
              const persistence = hostCtx.get('sessionPersistence')
              return typeof persistence?.root === 'string' ? persistence.root : join(dshHome(), 'sessions')
            })(),
          })
        },
      })
      return () => {
        disposeDelete?.()
        disposeStatus?.()
      }
    }, 'dsh-session-delete: http routes')
  })
}
