/**
 * Headless behavioural test for the browser half.
 *
 * There is no browser here, so this file fakes exactly three things: the module
 * loader wrapper, the two `require`d modules the bundle needs, and the client
 * context. Everything else — the slot metadata, the injected share, the
 * component bodies, the fetch call, the list refresh, the toast — is the real
 * shipped code, driven through its real entry points.
 *
 * Function components are expanded by a tiny renderer so the assertions can see
 * host elements ('menuitem-button', 'modal', …) instead of function references.
 *
 * Run with: node test/client-render-check.mjs
 */
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const failures = []
const check = (label, condition, detail = '') => {
  if (condition) console.log(`ok   ${label}`)
  else {
    console.log(`FAIL ${label} ${detail}`)
    failures.push(label)
  }
}

// ---------------------------------------------------------------- loader stub
let loaded = null
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      loaded = spec
    }
  }
}

// ------------------------------------------------------------------ react stub
const jsx = (type, props, key) => ({ type, props: props ?? {}, key })
const Fragment = Symbol('Fragment')
const react = {
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  createElement: jsx,
  Fragment
}
const jsxRuntime = { jsx, jsxs: jsx, Fragment }

// ------------------------------------------------------------- primitives stub
const primitives = {
  IconTrashOutlineRegular: (props) => jsx('icon-trash', props),
  MenuItemButton: (props) => jsx('menuitem-button', props),
  Tooltip: (props) => jsx('tooltip', props),
  Modal: (props) => jsx('modal', props),
  Button: (props) => jsx('button', props),
  Toast: (props) => jsx('toast', props)
}
const requireStub = (name) => {
  if (name === 'react') return react
  if (name === 'react/jsx-runtime') return jsxRuntime
  if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives
  throw new Error(`unexpected require: ${name}`)
}

/** Expand function components into host elements, recursively. */
function render(node) {
  if (node === null || node === undefined || node === false || node === true) return null
  if (typeof node === 'string' || typeof node === 'number') return node
  if (Array.isArray(node)) return node.map(render)
  if (typeof node !== 'object' || !('props' in node)) return node
  if (typeof node.type === 'function') return render(node.type(node.props))
  // Render every element-valued prop (children, icon, footer, …), leaving
  // callbacks, strings, and plain data objects untouched.
  const props = {}
  for (const [key, value] of Object.entries(node.props)) {
    props[key] = value !== null && typeof value === 'object' && ('type' in value || Array.isArray(value))
      ? render(value)
      : value
  }
  return { type: node.type, key: node.key, props }
}
/** Every string in a rendered tree. */
function texts(node, out = []) {
  if (node === null || node === undefined) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const item of node) texts(item, out); return out }
  if (typeof node === 'object' && 'props' in node) texts(node.props.children, out)
  return out
}
/** First host element of the given type, searching every element-valued prop. */
function find(node, type) {
  if (node === null || node === undefined || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const item of node) { const hit = find(item, type); if (hit) return hit }
    return null
  }
  if (node.type === type) return node
  for (const value of Object.values(node.props ?? {})) {
    if (value !== null && typeof value === 'object' && ('type' in value || Array.isArray(value))) {
      const hit = find(value, type)
      if (hit) return hit
    }
  }
  return null
}

// ----------------------------------------------------------------- load bundle
await import(pathToFileURL(join(root, 'client', 'client.js')).href)
check('bundle 调用了 __ModuleLoader__.load', loaded !== null)
check('wrapper id 是包名', loaded?.id === 'dsh-session-delete', loaded?.id)

const plugin = loaded.factory(requireStub)
check('工厂返回 name/inject/apply', plugin?.name === 'dsh-session-delete' && Array.isArray(plugin.inject) && typeof plugin.apply === 'function')
check('声明了 slots/sessions/locale', ['slots', 'sessions', 'locale'].every((s) => plugin.inject.includes(s)), plugin.inject.join(','))

// ------------------------------------------------------------------ ctx stub
const registrations = []
const refreshCalls = []
const localeRegistered = []
/** Ordered trace of the list calls, so the refresh-then-remove order is assertable. */
const sequence = []
const services = {
  sessions: {
    refresh: async () => {
      refreshCalls.push(Date.now())
      sequence.push('refresh')
    },
    /** The handler the host's `api-session/removed` relay calls. */
    handleSessionRemoved: (sessionId) => {
      sequence.push(`removed:${sessionId}`)
    }
  }
}

/** The real slot system iterates the generator form of a contribution. */
function drive(result) {
  if (result !== null && result !== undefined && typeof result.next === 'function') {
    let step = result.next()
    while (step.done !== true) step = result.next()
  }
  return result
}

const ctx = {
  get: (name) => services[name],
  effect: (callback) => { drive(callback()) },
  locale: {
    register: (ns, dicts) => {
      localeRegistered.push({ ns, dicts })
      return () => {}
    },
    bind: () => (key, params) => {
      const template = localeRegistered[0]?.dicts?.zh?.[key] ?? key
      return params === undefined ? template : Object.entries(params).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), template)
    }
  },
  slots: {
    inject: (slot, callback) => { drive(callback()) },
    register: (meta, component) => {
      registrations.push({ meta, component })
      return () => {}
    }
  }
}

plugin.apply(ctx)

const bySlot = (slot) => registrations.filter((entry) => entry.meta.name === slot)
check('注册了侧栏菜单项', bySlot('sidebar.workspaces.session.menu.item').length === 1)
check('注册了悬停按钮', bySlot('sidebar.workspaces.session.row.action').length === 1)
check('注册了两个 overlay 条目（确认框 + 提示）', bySlot('shell.overlay').length === 2)
check('注册了字典', localeRegistered.length === 1 && Object.keys(localeRegistered[0].dicts.zh).length > 3)

const dict = localeRegistered[0].dicts.zh
const t = (key, params) => {
  const template = dict[key] ?? key
  return params === undefined ? template : Object.entries(params).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), template)
}
const useOf = (store) => (selector) => selector(store.getSnapshot())

// ------------------------------------------------- test 1: menu row behaviour
console.log('\n1) 侧栏菜单项')
const menuEntry = bySlot('sidebar.workspaces.session.menu.item')[0]
const menuShare = menuEntry.meta.inject()
const closed = []
let requested = null
const menuTree = render(menuEntry.component({
  sessionId: 'session-demo-1',
  displayTitle: '演示会话',
  useMenuOpenState: () => [true, (value) => closed.push(value)],
  t,
  ...menuShare,
  deleteSession: (sessionId, displayTitle) => { requested = { sessionId, displayTitle } }
}))
check('渲染出「删除会话」文案', texts(menuTree).includes('删除会话'), texts(menuTree).join('|'))
check('使用宿主菜单行组件', find(menuTree, 'menuitem-button') !== null)
check('带垃圾桶图标', find(menuTree, 'icon-trash') !== null)
find(menuTree, 'menuitem-button').props.onSelect()
check('点击后关闭菜单', closed.includes(false), JSON.stringify(closed))
check('点击后请求删除该会话', requested?.sessionId === 'session-demo-1' && requested?.displayTitle === '演示会话', JSON.stringify(requested))

// ---------------------------------------------- test 2: hover button behaviour
console.log('\n2) 悬停按钮')
const rowEntry = bySlot('sidebar.workspaces.session.row.action')[0]
const rowShare = rowEntry.meta.inject()
let rowRequested = null
const rowTree = render(rowEntry.component({
  sessionId: 'session-demo-2',
  displayTitle: '第二个会话',
  t,
  ...rowShare,
  deleteSession: (sessionId) => { rowRequested = sessionId }
}))
check('使用 Tooltip 包裹', find(rowTree, 'tooltip') !== null)
check('带 aria-label', find(rowTree, 'button')?.props['aria-label'] === '删除会话', JSON.stringify(find(rowTree, 'button')?.props['aria-label']))
find(rowTree, 'button').props.onClick()
check('一次点击即请求删除', rowRequested === 'session-demo-2', String(rowRequested))

// ------------------------------------- test 3: confirm dialog -> fetch -> refresh
console.log('\n3) 确认框 → 删除 → 刷新列表 → 提示')
const dialogEntry = bySlot('shell.overlay').find((entry) => entry.meta.id === 'dsh-session-delete-confirm')
const toastEntry = bySlot('shell.overlay').find((entry) => entry.meta.id === 'dsh-session-delete-toast')
const dialogShare = dialogEntry.meta.inject()
const toastShare = toastEntry.meta.inject()

check('确认框在无请求时返回 null', dialogEntry.component({
  ...dialogShare,
  useDeleteRequest: useOf(dialogShare.hooks.deleteRequest),
  t
}) === null)

menuEntry.component({
  sessionId: 'session-demo-3',
  displayTitle: '待删会话',
  useMenuOpenState: () => [true, () => {}],
  t,
  ...menuShare
}).props.onSelect()
check('请求已入队', dialogShare.hooks.deleteRequest.getSnapshot()?.sessionId === 'session-demo-3', JSON.stringify(dialogShare.hooks.deleteRequest.getSnapshot()))

const dialogTree = render(dialogEntry.component({
  ...dialogShare,
  useDeleteRequest: useOf(dialogShare.hooks.deleteRequest),
  t
}))
check('渲染确认框', find(dialogTree, 'modal') !== null, String(dialogTree))
const modalProps = find(dialogTree, 'modal').props
check('标题是「永久删除这个会话？」', modalProps.title === '永久删除这个会话？', modalProps.title)
check('描述里带会话标题', String(modalProps.description).includes('待删会话'), modalProps.description)
check('确认按钮文案是「永久删除」', texts(modalProps.footer).includes('永久删除'), texts(modalProps.footer).join('|'))

const calls = []
globalThis.fetch = async (url, init) => {
  calls.push({ url, init })
  return { ok: true, status: 200, json: async () => ({ ok: true, sessionId: 'session-demo-3', displayTitle: '待删会话' }) }
}
const footerButtons = modalProps.footer.props.children
await footerButtons[1].props.onClick()
await new Promise((resolve) => setTimeout(resolve, 20))

check('只发了一个请求', calls.length === 1, JSON.stringify(calls.map((call) => call.url)))
check('请求打到宿主路由', calls[0]?.url === '/dsh-session-delete/delete', calls[0]?.url)
check('请求体是 sessionId', calls[0]?.init?.body === JSON.stringify({ sessionId: 'session-demo-3' }), calls[0]?.init?.body)
check('POST + JSON', calls[0]?.init?.method === 'POST' && calls[0]?.init?.headers?.['content-type'] === 'application/json')
check('删除后刷新会话列表', refreshCalls.length === 1, `refresh x${refreshCalls.length}`)
check(
  '刷新后调用 handleSessionRemoved 丢弃侧栏行（顺序不能反）',
  sequence.join('|') === 'refresh|removed:session-demo-3',
  sequence.join('|')
)
check('请求已结算（确认框关闭）', dialogShare.hooks.deleteRequest.getSnapshot() === null, JSON.stringify(dialogShare.hooks.deleteRequest.getSnapshot()))

const toastTree = render(toastEntry.component({
  ...toastShare,
  useNotice: useOf(toastShare.hooks.notice),
  t
}))
const toastProps = find(toastTree, 'toast')?.props
check('弹出结果提示', toastProps !== undefined)
check('提示里带会话标题与不可恢复警告', String(toastProps?.text).includes('待删会话') && String(toastProps?.text).includes('不可恢复'), toastProps?.text)

// ------------------------------------------------- test 4: host refusal path
console.log('\n4) 宿主拒绝时的提示')
globalThis.fetch = async () => ({ ok: false, status: 409, json: async () => ({ ok: false, code: 'session-live', error: '这个会话正在运行，无法删除。' }) })
dialogShare.hooks.deleteRequest.set({ sessionId: 'session-live-1', displayTitle: '运行中' })
const refusedTree = render(dialogEntry.component({
  ...dialogShare,
  useDeleteRequest: useOf(dialogShare.hooks.deleteRequest),
  t
}))
await find(refusedTree, 'modal').props.footer.props.children[1].props.onClick()
await new Promise((resolve) => setTimeout(resolve, 20))
check('运行中的会话被拒绝后不刷新列表', refreshCalls.length === 1, `refresh x${refreshCalls.length}`)
check('请求保留在确认框里（可重试/取消）', dialogShare.hooks.deleteRequest.getSnapshot()?.sessionId === 'session-live-1')

// --------------------------------------- test 5: no-primitives degraded path
console.log('\n5) 原语模块缺失时的降级')
{
  loaded = null
  globalThis.window = { __ModuleLoader__: { load: (spec) => { loaded = spec } } }
  await import(`${pathToFileURL(join(root, 'client', 'client.js')).href}?degraded=1`)
  const degradedPlugin = loaded.factory((name) => {
    if (name === 'react') return react
    if (name === 'react/jsx-runtime') return jsxRuntime
    throw new Error('missing module')
  })
  const registrations2 = []
  let alertCalled = null
  globalThis.window.confirm = () => true
  globalThis.window.alert = (message) => { alertCalled = message }
  globalThis.fetch = async () => { throw new Error('network down') }
  degradedPlugin.apply({
    get: () => undefined,
    effect: (callback) => { drive(callback()) },
    locale: { register: () => () => {}, bind: () => (key) => key },
    slots: {
      inject: (slot, callback) => { drive(callback()) },
      register: (meta, component) => { registrations2.push({ meta, component }); return () => {} }
    }
  })
  const degradedEntry = registrations2.find((entry) => entry.meta.name === 'sidebar.workspaces.session.menu.item')
  const degradedTree = render(degradedEntry.component({
    sessionId: 'session-x',
    displayTitle: 'X',
    useMenuOpenState: () => [true, () => {}],
    t: (key) => key,
    ...degradedEntry.meta.inject()
  }))
  check('降级为普通按钮', find(degradedTree, 'button') !== null)
  find(degradedTree, 'button').props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 20))
  check('无 Modal 时用 window.confirm 兜底并报错提示', alertCalled !== null, String(alertCalled))
}

console.log(failures.length === 0 ? '\n全部通过 ✅' : `\n失败 ${failures.length} 项 ❌`)
process.exit(failures.length === 0 ? 0 : 1)
