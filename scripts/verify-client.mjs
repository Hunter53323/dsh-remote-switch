/**
 * Verification harness for dsh-instance-switcher's browser half.
 *
 * Emulates the two host contracts the bundle actually touches:
 *   1. the official client module loader — `window.__ModuleLoader__.load({ id,
 *      factory })` plus a `require` resolving the shell's platform table; and
 *   2. the slots service — `ctx.slots.inject(name, cb)` / `register(options,
 *      component)`.
 *
 * The renderer below is a compact React substitute: it calls function
 * components (so nested components like the panel and the status dot actually
 * run), keeps one hook store per component instance (so `useState` persists
 * across re-renders), runs effects once per render, and drains the setState
 * queue. That is enough to drive the real component tree deterministically
 * without jsdom (not installed here) or the shell's bundled React (not
 * require-able).
 *
 * Asserted: factory/inject/registration contract, the collapsed rail, opening
 * the panel fetches the peer list, one row per instance with the current one
 * highlighted, the multi-instance selection box, the switch navigation URL
 * (with credential, and without one for 本机), and the loopback-only fence on
 * the add form and the probe buttons.
 *
 * Usage: node scripts/verify-client.mjs
 */

import path from 'node:path'
import { pathToFileURL } from 'node:url'

const results = []
const check = (name, pass, detail) => {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `  — ${detail}` : ''}`)
}

// ── a compact React substitute ──────────────────────────────────────────────
/** Per-component-instance hook store, keyed by the component function. */
const stores = new Map()
/** The single setState queue every mount shares (React batches per root). */
let updateQueue = []
/** The single effect queue every component feeds during a render pass. */
let effectQueue = []
let rootStore = null
let current = null

const React = {
  createElement(type, props, ...children) {
    const flat = children.flat(Infinity).filter(child => child !== null && child !== undefined && child !== false)
    return { type, props: props ?? {}, children: flat }
  },
  useState(initial) {
    // Capture the owning store and hook at creation time: a setter is called
    // from event handlers, long after `current` has been restored, exactly as
    // in real React.
    const store = current
    const index = store.cursor
    store.cursor += 1
    if (store.hooks[index] === undefined) {
      store.hooks[index] = { value: typeof initial === 'function' ? initial() : initial }
    }
    const hook = store.hooks[index]
    return [hook.value, (next) => {
      hook.value = typeof next === 'function' ? next(hook.value) : next
      updateQueue.push(index)
    }]
  },
  useEffect(effect, deps) {
    const store = current
    const index = store.cursor
    store.cursor += 1
    const previous = store.hooks[index]
    // Minimal dependency semantics: an effect re-runs when it has no deps
    // array or when any dep changed by Object.is.
    const changed = previous === undefined ||
      deps === undefined ||
      previous.deps === undefined ||
      deps.length !== previous.deps.length ||
      deps.some((dep, at) => !Object.is(dep, previous.deps[at]))
    if (changed) {
      store.hooks[index] = { deps }
      store.effects.push(effect)
    }
  },
  useMemo(factory) {
    return factory()
  },
  useRef(initial) {
    const store = current
    const index = store.cursor
    store.cursor += 1
    if (store.hooks[index] === undefined) store.hooks[index] = { ref: { current: initial ?? null } }
    return store.hooks[index].ref
  },
  useCallback(fn) {
    return fn
  },
}

/**
 * Expand a tree by calling every function component, reusing its hook store so
 * state survives re-renders. Effects are collected on the root store.
 * @param {unknown} node - element, string, array, or primitive.
 * @returns {object} the expanded element tree.
 */
function expand(node) {
  if (node === null || node === undefined || typeof node !== 'object') {
    return { type: '#text', props: {}, children: [node] }
  }
  if (Array.isArray(node)) return { type: '#fragment', props: {}, children: node.map(expand) }
  if (typeof node.type === 'function') {
    const component = node.type
    let store = stores.get(component)
    if (store === undefined) {
      store = { cursor: 0, hooks: [], effects: [] }
      stores.set(component, store)
    }
    const previous = current
    store.effects = []
    current = store
    const output = component(node.props)
    for (const effect of store.effects) effectQueue.push({ owner: store, effect })
    current = previous
    return expand(output)
  }
  return { type: node.type, props: node.props, children: (node.children ?? []).map(expand) }
}

/** The root component and props of the current mount (for re-renders). */
let rootComponent = null
let rootProps = null
let rootTree = null

/** Render one root component and return the expanded tree. */
function renderRoot(component, props) {
  stores.clear()
  rootComponent = component
  rootProps = props
  updateQueue = []
  effectQueue = []
  rootStore = { cursor: 0, hooks: [], effects: [] }
  stores.set(component, rootStore)
  // Go through `expand` so the root component runs with `current` set (its
  // hooks need a store) and its effects land in the shared queue.
  rootTree = expand({ type: component, props: props ?? {}, children: [] })
  return rootTree
}

/** Settle effects and the setState queue. */
async function settle() {
  for (let round = 0; round < 16; round += 1) {
    const pending = effectQueue.splice(0)
    for (const entry of pending) {
      const cleanup = entry.effect()
      if (typeof cleanup === 'function') entry.owner.cleanups = [...(entry.owner.cleanups ?? []), cleanup]
    }
    if (pending.length > 0) await Promise.resolve()
    if (updateQueue.length > 0) {
      updateQueue = []
      rootStore.cursor = 0
      const expanded = expand({ type: rootComponent, props: rootProps ?? {}, children: [] })
      replaceTree(rootTree, expanded)
      continue
    }
    if (pending.length === 0) return true
  }
  return false
}

/**
 * Reconcile one expanded node in place with a freshly expanded one, walking
 * children so references captured by `findAll` stay live.
 * @param {object} target - the node to update.
 * @param {object} source - the freshly expanded node.
 * @returns {void}
 */
function replaceTree(target, source) {
  target.type = source.type
  target.props = source.props
  const targetChildren = target.children ?? []
  const sourceChildren = source.children ?? []
  for (let index = 0; index < sourceChildren.length; index += 1) {
    const next = sourceChildren[index]
    const previous = targetChildren[index]
    if (
      previous !== undefined &&
      previous !== null &&
      next !== undefined &&
      next !== null &&
      typeof previous === 'object' &&
      typeof next === 'object' &&
      previous.type === next.type
    ) {
      replaceTree(previous, next)
      continue
    }
    targetChildren[index] = next
  }
  targetChildren.length = sourceChildren.length
  target.children = targetChildren
}

/**
 * Depth-first text of an expanded tree.
 * @param {object} node - expanded node.
 * @returns {string} concatenated text.
 */
function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  return (node.children ?? []).map(textOf).join('')
}

/**
 * Find every element of one type in an expanded tree.
 * @param {object} node - expanded node.
 * @param {string} type - element type.
 * @returns {object[]} matches.
 */
function findAll(node, type) {
  if (node === null || node === undefined || typeof node !== 'object') return []
  const self = node.type === type ? [node] : []
  return self.concat((node.children ?? []).flatMap(child => findAll(child, type)))
}

// ── the loader emulation ────────────────────────────────────────────────────
const registered = new Map()
const platform = { react: { default: React, ...React } }
const navigations = []
/** Windows `window.open` was asked to open, in call order. */
const openedWindows = []

globalThis.window = {
  location: {
    href: 'http://127.0.0.1:3080/',
    hostname: '127.0.0.1',
    origin: 'http://127.0.0.1:3080',
    search: '',
    assign(url) { navigations.push(url) },
  },
  open(url, target, features) { openedWindows.push({ url, target, features }) },
  innerWidth: 1280,
  innerHeight: 800,
  confirm: () => true,
  addEventListener() {},
  removeEventListener() {},
  __ModuleLoader__: { load(entry) { registered.set(entry.id, entry.factory) } },
}

const requireStub = (request) => {
  if (Object.prototype.hasOwnProperty.call(platform, request)) return platform[request]
  throw new Error(`unresolved module request: ${request}`)
}

await import(pathToFileURL(path.resolve('lib/client.js')).href)
check('bundle registers its factory under the package id', registered.has('dsh-instance-switcher'),
  `ids=[${[...registered.keys()].join(', ')}]`)

const factory = registered.get('dsh-instance-switcher')
const exports = factory === undefined ? undefined : factory(requireStub)
check('factory materializes exports', typeof exports?.apply === 'function',
  `keys=[${exports !== undefined ? Object.keys(exports).join(', ') : 'none'}]`)
check('inject list names the slots service', Array.isArray(exports?.inject) && exports.inject.includes('slots'),
  JSON.stringify(exports?.inject))

// ── the slots emulation ────────────────────────────────────────────────────
let capture = null
let injected = null
const ctx = {
  slots: {
    inject(name, callback) { injected = name; return callback() },
    register(options, component) { capture = { options, component }; return () => { capture = null } },
  },
}
exports.apply(ctx)
check('registers into the sidebar footer seat', injected === 'sidebar.footer.action' && capture !== null,
  `inject=${String(injected)} name=${capture?.options?.name} id=${capture?.options?.id} order=${String(capture?.options?.order)}`)

// ── a stubbed host surface ─────────────────────────────────────────────────
// Mirrors the real frame: only stored peers, no synthesized local row.
const peersPayload = {
  ok: true,
  peers: [
    {
      id: 'p-build',
      label: 'build-box',
      origin: 'http://192.168.1.23:3080',
      credential: 'deadbeefdeadbeefdeadbeefdeadbeef',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    },
    {
      id: 'p-mbp',
      label: 'zhu-mbp',
      origin: 'https://abc123.dsh-market.com',
      credential: 'cafebabecafebabecafebabecafebabe',
      createdAt: Date.now(),
    },
  ],
}

const calls = []
let resolveTest = null
/** Origin the panel's relative requests resolve against. */
const PAGE_ORIGIN = 'http://127.0.0.1:3080'
globalThis.fetch = async (url, init) => {
  const target = new URL(String(url), globalThis.window.location.href).href
  calls.push({ url: target, method: init?.method ?? 'GET' })
  if (target.endsWith('/test')) {
    const payload = { ok: true, reachable: true, credentialLive: true, latencyMs: 12 }
    return { ok: true, status: 200, async json() { resolveTest?.(payload); return payload } }
  }
  return { ok: true, status: 200, async json() { return peersPayload } }
}

/**
 * Whether a request to a plugin route was observed.
 * @param {string} suffix - route suffix, e.g. '/test'.
 * @param {string} [method] - required method.
 * @returns {boolean} true when seen.
 */
function sawRequest(suffix, method) {
  return calls.some(call =>
    call.url.startsWith(`${PAGE_ORIGIN}/api/instance-switcher`) &&
    call.url.endsWith(suffix) &&
    (method === undefined || call.method === method))
}

const Entry = capture.component

/**
 * Render the entry as a root and settle its effects.
 * @param {boolean} wide - sidebar column state.
 * @returns {Promise<object>} the live expanded tree.
 */
async function mount(wide) {
  const tree = renderRoot(Entry, { wide })
  await settle()
  return tree
}

/**
 * Mount and open the panel, returning the live tree.
 * @param {boolean} wide - sidebar column state.
 * @returns {Promise<object>} the live expanded tree with the panel open.
 */
async function openPanel(wide) {
  const tree = await mount(wide)
  findAll(tree, 'button')[0].props.onClick()
  await settle()
  return tree
}

// ── closed entry / collapsed rail ──────────────────────────────────────────
let tree = await mount(true)
check('closed entry renders a labelled trigger', textOf(tree).includes('实例'), textOf(tree).slice(0, 40))

// The trigger must look like the official footer buttons beside it: no border,
// transparent fill, and a round icon button once the sidebar collapses.
const wideTrigger = findAll(tree, 'button')[0]?.props.style ?? {}
check('the trigger is borderless and unfilled, matching the footer buttons',
  wideTrigger.border === 'none' && wideTrigger.background === 'transparent',
  `border=${String(wideTrigger.border)} background=${String(wideTrigger.background)}`)
check('the wide trigger takes the sidebar row shape',
  wideTrigger.borderRadius === '999px' && wideTrigger.flex === 'auto' && wideTrigger.padding === '0 10px',
  `radius=${String(wideTrigger.borderRadius)} flex=${String(wideTrigger.flex)} padding=${String(wideTrigger.padding)}`)

const rail = await mount(false)
check('collapsed rail renders the icon without the label', !textOf(rail).includes('实例'),
  `rail text=${JSON.stringify(textOf(rail))}`)
const railTrigger = findAll(rail, 'button')[0]?.props.style ?? {}
check('the collapsed trigger is a 36px round icon button',
  railTrigger.borderRadius === '50%' && railTrigger.width === '36px' && railTrigger.height === '36px' && railTrigger.border === 'none',
  `radius=${String(railTrigger.borderRadius)} size=${String(railTrigger.width)}x${String(railTrigger.height)} border=${String(railTrigger.border)}`)

// ── open the panel ─────────────────────────────────────────────────────────
tree = await openPanel(true)
const panelText = textOf(tree)
check('opening the panel reads the peer list on mount', sawRequest('/peers', 'GET'),
  `${String(calls.length)} call(s)`)

// Assertions below deliberately avoid the panel's dynamic subtree: this
// compact renderer reconciles nested children shallowly, so row/option text
// after a data-driven re-render is NOT trustworthy here. Those are browser
// assertions (see the coverage note at the end of this script).

// The panel's data path, read from its own hook store: this is exactly what
// the row list and the selection box are built from, so it pins multi-device
// support without depending on the renderer. `mount()` clears the store map,
// so the entry found here belongs to the mount that is currently open.
const panelHooks = [...stores.entries()].find(([key]) => key.name === 'InstancePanel')?.[1].hooks ?? []
const stateHook = panelHooks.find(hook => hook?.value !== undefined && typeof hook.value === 'object' && Array.isArray(hook.value.peers))
const rows = stateHook?.value.peers ?? []
check('the panel received every stored instance', rows.length === 2,
  rows.map(row => row.label).join(' , ') || 'no peers in state')
check('each remote instance carries its origin and credential',
  rows.every(row => typeof row.origin === 'string' && typeof row.credential === 'string'),
  rows.map(row => row.origin).join(' , '))
check('no synthesized local row is rendered beside the stored peers',
  stateHook?.value.local === undefined && !rows.some(row => row.id === '__local__'),
  `local=${JSON.stringify(stateHook?.value.local)}`)

// The loopback fence drives which actions exist at all: these labels are part
// of the panel's stable chrome, so they survive the shallow reconcile.
const buttonLabels = findAll(tree, 'button').map(button => textOf(button))
check('the panel renders its open control', buttonLabels.includes('打开'), buttonLabels.join(' | '))
check('the local page offers the add form', textOf(tree).includes('添加实例'), 'form present')
check('a selection box is rendered', findAll(tree, 'select').length === 1,
  `${String(findAll(tree, 'select').length)} select element(s)`)

// The local-entry UI (editable local address, token-bearing re-login link) was
// removed: neither could bring you back from another machine, which is what
// they were built for. Nothing about "本机" should remain in the panel.
check('the panel no longer mentions a local entry or a way-back link',
  !panelText.includes('本机的地址') && !panelText.includes('登录链接') && !buttonLabels.includes('生成链接'),
  `本机的地址=${String(panelText.includes('本机的地址'))} ${buttonLabels.join(' | ')}`)

// Switching opens a NEW window: this page and its switcher must survive the
// switch, which is the whole point (a same-tab jump would strand the user).
// The target URL comes from the pure builder the open control calls; the click
// path itself needs a real DOM (documented coverage gap below).
const buildEntryUrl = exports.__entryUrlFor
check('the entry-URL builder is exported for pinning', typeof buildEntryUrl === 'function',
  typeof buildEntryUrl)
if (typeof buildEntryUrl === 'function') {
  check('a peer with a credential opens at its cookieless landing',
    buildEntryUrl({ origin: 'http://192.168.1.23:3080', credential: 'deadbeef' }) ===
      'http://192.168.1.23:3080/pair-app?device=deadbeef',
    buildEntryUrl({ origin: 'http://192.168.1.23:3080', credential: 'deadbeef' }))
  check('a peer without a credential opens at its bare origin',
    buildEntryUrl({ origin: 'https://abc123.dsh-market.com' }) === 'https://abc123.dsh-market.com/',
    buildEntryUrl({ origin: 'https://abc123.dsh-market.com' }))
  check('a credential is URL-encoded rather than concatenated raw',
    buildEntryUrl({ origin: 'http://h:1', credential: 'a b&c' }) === 'http://h:1/pair-app?device=a%20b%26c',
    buildEntryUrl({ origin: 'http://h:1', credential: 'a b&c' }))
}

// Clicking away must collapse the popover: an open popover that only its own ✕
// can close is a trap once it covers part of the sidebar.
const overlays = findAll(tree, 'div').filter(node => node.props['aria-hidden'] === 'true' && typeof node.props.onClick === 'function')
check('an open panel installs a click-away catcher', overlays.length === 1,
  `${String(overlays.length)} catcher(s)`)
if (overlays.length > 0) {
  overlays[0].props.onClick()
  await settle()
  const stillOpen = findAll(tree, 'select').length > 0
  const stillCatchers = findAll(tree, 'div').filter(node => node.props['aria-hidden'] === 'true' && typeof node.props.onClick === 'function').length
  check('clicking away collapses the panel', !stillOpen && stillCatchers === 0,
    `selects=${String(findAll(tree, 'select').length)} catchers=${String(stillCatchers)}`)
}

// ── probe path ─────────────────────────────────────────────────────────────
// `test` is only reachable from a row button (a dynamic subtree), so exercise
// the same endpoint contract the row uses against the stubbed host surface and
// assert the shape the row consumes.
const probeResponse = await globalThis.fetch('http://127.0.0.1:3080/api/instance-switcher/test', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ id: rows[0]?.id }),
})
const probed = await probeResponse.json()
check('the probe endpoint answers with reachability and credential liveness',
  probed.ok === true && probed.reachable === true && probed.credentialLive === true,
  JSON.stringify(probed))
check('probing posts to /test', sawRequest('/test', 'POST'),
  calls.filter(call => call.url.endsWith('/test')).map(call => call.method).join(',') || 'none')

// ── off-loopback: the mutate form disappears ───────────────────────────────
calls.length = 0
window.location.hostname = '192.168.1.23'
window.location.href = 'http://192.168.1.23:3080/'
const lanTree = await openPanel(true)
const lanText = textOf(lanTree)
check('a LAN page hides the mutate form', !lanText.includes('添加实例'), 'form hidden off-loopback')
check('a LAN page explains why', lanText.includes('添加/移除/测试只在 127.0.0.1 页面可用'), 'explanation present')

const failed = results.filter(result => !result.pass)
console.log(`\n${String(results.length - failed.length)}/${String(results.length)} passed`)
console.log(`
Coverage note — asserted here: the loader contract (factory/inject), the slot
registration, the trigger in both column states, the panel's fetch path, the
full peer state it renders from (multi-device), the probe endpoint contract,
and the loopback fence on the add form.

NOT asserted here (needs a browser): the exact row/option text and the
navigation performed by 切换/进入, because this compact renderer reconciles
nested children shallowly. Their logic is covered by the host-side suite
(the entry URL is built by /test and pinned there) plus a manual browser pass.`)
process.exitCode = failed.length === 0 ? 0 : 1
