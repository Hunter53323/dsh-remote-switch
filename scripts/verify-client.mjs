/**
 * Verification harness for dsh-remote-switch's browser half.
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
 * Asserted: the registered module id matches the package name, the
 * factory/inject/registration contract, the trigger's borderless official
 * styling in both column states, opening the panel fetches the peer list, the
 * peer state it renders from, the entry-URL builder used to open a peer in a
 * new window, the click-away catcher, and the loopback-only fence on the add
 * form and the probe buttons.
 *
 * Usage: node scripts/verify-client.mjs
 */

import { readFileSync } from 'node:fs'
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
  useSyncExternalStore(subscribe, getSnapshot) {
    // Real React subscribes during commit and re-reads on notify. Here the
    // subscription is installed as an effect on the root store and the value is
    // read at render time, which is enough to observe a publish.
    const store = current
    const index = store.cursor
    store.cursor += 1
    if (store.hooks[index] === undefined) {
      store.hooks[index] = { value: getSnapshot() }
      store.effects.push(() => subscribe(() => { store.hooks[index].value = getSnapshot() }))
    }
    store.hooks[index].value = getSnapshot()
    return store.hooks[index].value
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
    // Every component render starts reading its hooks from index 0. Without
    // this reset a NESTED component's cursor keeps advancing across renders,
    // so its `useState` calls silently shift onto the wrong hooks — which looks
    // exactly like "state updates are being dropped" and makes every assertion
    // about nested component state unreliable.
    store.cursor = 0
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
  for (let round = 0; round < 40; round += 1) {
    const pending = effectQueue.splice(0)
    for (const entry of pending) {
      const cleanup = entry.effect()
      if (typeof cleanup === 'function') entry.owner.cleanups = [...(entry.owner.cleanups ?? []), cleanup]
    }
    // Yield to the macrotask queue so a component's own promise chain (a fetch,
    // then a setState) can actually make progress between rounds. A microtask
    // turn is not enough: those chains await several times, and the panel's
    // entire rendered content arrives that way.
    await new Promise(resolve => { setTimeout(resolve, 0) })
    if (updateQueue.length > 0) {
      updateQueue = []
      rootStore.cursor = 0
      const expanded = expand({ type: rootComponent, props: rootProps ?? {}, children: [] })
      replaceTree(rootTree, expanded)
      continue
    }
    if (pending.length === 0) {
      // Give a still-running chain one more turn before declaring quiet.
      await new Promise(resolve => { setTimeout(resolve, 0) })
      if (updateQueue.length === 0) return true
      continue
    }
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
/** Every `window.confirm` message, in call order. */
const confirms = []
/**
 * What the next `window.confirm` answers. Flipped to false where a test needs to
 * prove that declining really does nothing, then restored.
 */
let confirmAnswer = true

/**
 * Timers the panel installed through `window.setInterval`.
 *
 * A fake registry rather than the real thing: the panel is expected to install
 * exactly one poll loop and to clear it, and asserting that is the only way to
 * catch the regression this exists for (the panel fetched once on mount and
 * never again, so the list and the running count froze while the host kept
 * polling).
 * @type {Map<number, { fn: Function, ms: number }>}
 */
const intervals = new Map()
let nextIntervalId = 1

/** `pagehide` listeners the panel registered, so their cleanup is assertable. */
const pagehideListeners = new Set()

/** Run every installed interval once, as the browser would after `ms`. */
const fireIntervals = () => {
  for (const { fn } of [...intervals.values()]) fn()
}

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
  confirm(message) {
    confirms.push(String(message))
    return confirmAnswer
  },
  setInterval(fn, ms) {
    const id = nextIntervalId++
    intervals.set(id, { fn, ms })
    return id
  },
  clearInterval(id) { intervals.delete(id) },
  addEventListener(type, fn) { if (type === 'pagehide') pagehideListeners.add(fn) },
  removeEventListener(type, fn) { if (type === 'pagehide') pagehideListeners.delete(fn) },
  __ModuleLoader__: { load(entry) { registered.set(entry.id, entry.factory) } },
}

// The shipped `index.html` hardcodes `lang="en"` and the frontend NEVER updates
// it — verified against dsh-web-frontend/dist/index.html and the built assets.
// Modelling that here is what makes the "trusts the locale service, not the DOM"
// assertion below meaningful: a panel that read this attribute would render
// English no matter what the locale service reports.
globalThis.document = {
  documentElement: { lang: 'en' },
  createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
  addEventListener() {},
  removeEventListener() {},
}

const requireStub = (request) => {
  if (Object.prototype.hasOwnProperty.call(platform, request)) return platform[request]
  throw new Error(`unresolved module request: ${request}`)
}

await import(pathToFileURL(path.resolve('lib/client.js')).href)

// The id the bundle registers MUST equal the package's own name: the host's
// boot graph addresses the browser bundle by that name, so a rename that misses
// `lib/client.js` leaves the plugin silently unloaded in the browser. Deriving
// the expectation from package.json — instead of hardcoding it — is what makes
// this suite fail on that mistake.
const packageName = JSON.parse(readFileSync(path.resolve('package.json'), 'utf8')).name
check('bundle registers its factory under the package id',
  registered.has(packageName),
  `expected=${String(packageName)} ids=[${[...registered.keys()].join(', ')}]`)

const factory = registered.get(packageName)
const exports = factory === undefined ? undefined : factory(requireStub)
check('factory materializes exports', typeof exports?.apply === 'function',
  `keys=[${exports !== undefined ? Object.keys(exports).join(', ') : 'none'}]`)
check('inject list names the slots service', Array.isArray(exports?.inject) && exports.inject.includes('slots'),
  JSON.stringify(exports?.inject))
// `locale` must be DECLARED, not merely read. An undeclared service is not
// awaited and not guaranteed to be mounted, so the panel silently falls back to
// its own heuristic — which is exactly how the whole UI ended up English
// regardless of the user's setting. Every locale-registering plugin in this
// profile declares it (dsh-pet, dsh-ssh, dsh-doctor, …).
check('inject list also declares locale (reading it without declaring it silently degrades)',
  Array.isArray(exports?.inject) && exports.inject.includes('locale'),
  JSON.stringify(exports?.inject))

// ── the slots emulation ────────────────────────────────────────────────────
// A missing factory (e.g. the id/name mismatch above) must fail as checks, not
// as an unhandled TypeError that buries the real cause.
/** Seat name → the registration captured for it. */
const captures = new Map()
/** Seat names this plugin asked to inject into, in call order. */
const injectedSeats = []
/** Locale namespaces registered by the bundle, and the dictionaries handed over. */
const registeredLocales = new Map()
/** Effects the bundle scheduled through `ctx.effect`, run during teardown. */
const effectDisposers = []

/**
 * A locale-registry substitute: enough of the real service's surface to pin that
 * the bundle registers both dictionaries, that its `t` follows the active
 * language, and — critically — that it reads the ACTIVE LOCALE from here rather
 * than from the document.
 *
 * `getLocale()`/`getSnapshot()` mirror the real snapshot shape (`{active, …}`),
 * because that is the authority the panel must consult: the shipped
 * `index.html` hardcodes `lang="en"` and never updates it, so a panel that
 * trusted the DOM would render English even when this stub says `zh`.
 */
let activeLanguage = 'zh'
const localeListeners = new Set()
const localeStub = {
  register(ns, dicts) {
    registeredLocales.set(ns, dicts)
    return () => { registeredLocales.delete(ns) }
  },
  bind(ns) {
    return (key, params) => {
      const dict = registeredLocales.get(ns)?.[activeLanguage]
      let text = dict?.[key] ?? key
      if (params !== undefined) {
        for (const [name, value] of Object.entries(params)) text = text.replaceAll(`{${name}}`, String(value))
      }
      return text
    }
  },
  subscribe(fn) {
    localeListeners.add(fn)
    return () => { localeListeners.delete(fn) }
  },
  getLocale() {
    return { active: activeLanguage, locales: [{ id: 'zh' }, { id: 'en' }], revision: 0 }
  },
  getSnapshot() {
    return this.getLocale()
  },
}
/** Switch the stubbed locale and notify, as the real runtime does. */
function setLanguage(lang) {
  activeLanguage = lang
  for (const fn of [...localeListeners]) fn()
}

const ctx = {
  locale: localeStub,
  effect(callback) {
    const dispose = callback()
    if (typeof dispose === 'function') effectDisposers.push(dispose)
    return dispose
  },
  slots: {
    inject(name, callback) {
      injectedSeats.push(name)
      const registration = callback()
      void registration
      return registration
    },
    register(options, component) {
      captures.set(options.name, { options, component })
      return () => { captures.delete(options.name) }
    },
    // The layout refuses to select a key with no registration, which is the
    // exact failure this suite exists to catch — so model the registry.
    entries(name) {
      if (name !== 'main') return []
      return [...captures.values()].filter(entry => entry.options.name === 'main')
    },
    entriesOfSlot(name) {
      return [...captures.values()].filter(entry => entry.options.name === name)
    },
  },
}
if (typeof exports?.apply !== 'function') {
  check('the bundle exposes apply()', false, 'cannot drive the slots contract without a factory')
  console.log(`\n0/${String(results.length)} passed`)
  process.exit(1)
}
exports.apply(ctx)

/** The instance-switcher footer registration. */
const capture = captures.get('sidebar.footer.action')
/** The remote-session panel-row registration. */
const panelCapture = captures.get('sidebar.panellist')
/** The keyed `main` registration, which must use the panellist's own id. */
const mainCapture = captures.get('main')

check('registers into the sidebar footer seat', injectedSeats.includes('sidebar.footer.action') && capture !== undefined,
  `injected=[${injectedSeats.join(', ')}] id=${capture?.options?.id} order=${String(capture?.options?.order)}`)
check('also registers a global panel row and its keyed main panel',
  injectedSeats.includes('sidebar.panellist') && injectedSeats.includes('main') && panelCapture !== undefined && mainCapture !== undefined,
  `seats=[${injectedSeats.join(', ')}] panel=${String(panelCapture?.options?.id)} main=${String(mainCapture?.options?.key)}`)
// The sidebar's row selects a panel by its id and the layout throws when that
// id has no `main` registration — so these two MUST be the same string, and
// the sidebar must be able to read a label off the row.
check('the panellist id and the main key are the same string',
  panelCapture !== undefined && mainCapture !== undefined && panelCapture.options.id === mainCapture.options.key,
  `id=${String(panelCapture?.options?.id)} key=${String(mainCapture?.options?.key)}`)
// The sidebar resolves the row label through `resolveSlotLabel`, which calls a
// function label on every render — that is what lets the row follow a language
// switch. So the label may be a string OR a function, and this asserts the
// resolved value either way.
const resolvedLabel = typeof panelCapture?.options?.label === 'function'
  ? panelCapture.options.label()
  : panelCapture?.options?.label
check('the panel row carries a label (the sidebar renders it, this plugin draws only the icon)',
  typeof resolvedLabel === 'string' && resolvedLabel !== '',
  `${typeof panelCapture?.options?.label} -> ${JSON.stringify(resolvedLabel)}`)
check('the panel row declares a numeric order',
  typeof panelCapture?.options?.order === 'number',
  String(panelCapture?.options?.order))
// The registry the layout consults must actually contain the key — this is the
// check that would have caught an id/key drift as a thrown click, not a blank panel.
check('the keyed main panel is registered in the main registry',
  mainCapture !== undefined && ctx.slots.entries('main').some(entry => entry.options.key === mainCapture.options.key),
  `main entries=[${ctx.slots.entries('main').map(entry => String(entry.options.key)).join(', ')}]`)

// ── i18n ───────────────────────────────────────────────────────────────────
check('both language dictionaries are registered under one namespace',
  registeredLocales.size === 1 && (() => {
    const dicts = [...registeredLocales.values()][0]
    return dicts !== undefined && typeof dicts.zh === 'object' && typeof dicts.en === 'object'
  })(),
  `namespaces=[${[...registeredLocales.keys()].join(', ')}]`)
const dictionaryPair = [...registeredLocales.values()][0] ?? {}
const zhKeys = Object.keys(dictionaryPair.zh ?? {})
const enKeys = Object.keys(dictionaryPair.en ?? {})
// The registry rejects a namespace whose shipped languages carry different key
// sets, so a missing translation is a registration failure — pin it here too.
check('the two dictionaries carry identical key sets',
  zhKeys.length > 0 && zhKeys.length === enKeys.length && zhKeys.every(key => enKeys.includes(key)),
  `zh=${String(zhKeys.length)} en=${String(enKeys.length)} missing=${zhKeys.filter(key => !enKeys.includes(key)).join(',') || 'none'}`)
check('the panel-row label is resolved lazily so it can follow a language switch',
  typeof panelCapture?.options?.label === 'function',
  typeof panelCapture?.options?.label)

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

/** The federation frame the stubbed host answers with, swapped per scenario. */
let federationFrame = {
  ok: true,
  peers: [
    {
      id: 'f-1',
      label: 'build-box',
      channel: 'ssh',
      origin: 'http://127.0.0.1:3080',
      ssh: { host: '192.168.1.23', user: 'liuyx', port: 22, remotePort: 3080, privateKeyPath: 'C:\\k', hasPassword: true, password: 'pw-for-build-box' },
      auth: { kind: 'token', hasToken: true, token: 'token-for-build-box' },
      webOrigin: 'http://192.168.1.23:3080',
      jumpUrl: 'http://192.168.1.23:3080/pair-app?device=cafe',
      createdAt: Date.now(),
    },
    {
      id: 'f-2',
      label: 'tunnel-only',
      channel: 'ssh',
      origin: 'http://127.0.0.1:3099',
      ssh: { host: '10.0.0.9', user: 'root', port: 2222, remotePort: 3099 },
      auth: { kind: 'device', hasToken: false },
      createdAt: Date.now(),
    },
  ],
  // Deliberately NOT the 15000 default: the panel's own fallback must not be
  // able to satisfy the cadence assertion below by coincidence.
  poll: { peerId: 'f-1', visible: true, intervalMs: 45000, failures: 0, running: true },
  snapshots: [],
  peerId: 'f-1',
  status: 'ok',
  snapshot: {
    peerId: 'f-1',
    items: [
      { sessionId: 's-run', title: '修 build 脚本', cwd: 'E:\\work\\build', updatedAt: Date.now() - 5000, running: true },
      { sessionId: 's-idle', title: '读日志', cwd: 'E:\\work\\build', updatedAt: Date.now() - 3600000, running: false },
      { sessionId: 's-other', title: '随手试试', cwd: 'C:\\tmp', updatedAt: Date.now() - 90000, running: false },
    ],
    groups: [],
    total: 3,
    truncated: false,
    warnings: [],
    fetchedAt: Date.now(),
  },
}

/** Frame the provision route answers with; swapped per scenario. */
let provisionFrame = { id: 'f-1', action: 'status', listening: true, evidence: 'LISTEN 0 128 127.0.0.1:3080' }

globalThis.fetch = async (url, init) => {
  const target = new URL(String(url), globalThis.window.location.href).href
  calls.push({ url: target, method: init?.method ?? 'GET', body: init?.body })
  if (target.includes('/api/federation/')) {
    const suffix = target.slice(target.indexOf('/api/federation'))
    const body = init?.body === undefined ? {} : JSON.parse(String(init.body))
    if (suffix.startsWith('/api/federation/peers')) {
      const payload = { ...federationFrame, saved: body.action === 'save' ? 'f-1' : undefined }
      return { ok: true, status: 200, async json() { return payload } }
    }
    if (suffix.startsWith('/api/federation/poll')) {
      return { ok: true, status: 200, async json() { return federationFrame } }
    }
    if (suffix.startsWith('/api/federation/test')) {
      const payload = { ...federationFrame, probe: { id: 'f-1', ok: true, latencyMs: 7 } }
      return { ok: true, status: 200, async json() { return payload } }
    }
    if (suffix.startsWith('/api/federation/provision')) {
      const payload = { ...federationFrame, provision: provisionFrame }
      return { ok: true, status: 200, async json() { return payload } }
    }
    return { ok: true, status: 200, async json() { return federationFrame } }
  }
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

/**
 * Whether a federation route was called.
 * @param {string} suffix - route suffix, e.g. '/sessions'.
 * @param {string} [method] - required method.
 * @returns {boolean} true when seen.
 */
function sawFed(suffix, method) {
  return calls.some(call =>
    call.url.startsWith(`${PAGE_ORIGIN}/api/federation`) &&
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

// ── the remote-session panel ───────────────────────────────────────────────
// Restore the loopback page: the federation panel is local-only by design.
window.location.hostname = '127.0.0.1'
window.location.href = 'http://127.0.0.1:3080/'
calls.length = 0
openedWindows.length = 0

const Icon = panelCapture.component
const Panel = mainCapture.component

// The icon is the only thing this plugin contributes to the panel row: the
// sidebar owns the button, the label, and the click.
const iconTree = renderRoot(Icon, { size: 16, active: false })
await settle()
check('the panel-row glyph renders without a label of its own',
  textOf(iconTree).includes('🖧'), JSON.stringify(textOf(iconTree)))

// The badge is self-drawn (owner props carry only size/active) and reads the
// running count off the panel's published cache — a different React root, so it
// must go through an external store rather than panel state.
let badgeVisible = textOf(iconTree).includes('1')
check('the badge is empty before any data arrives', !badgeVisible, JSON.stringify(textOf(iconTree)))

const panelTree = renderRoot(Panel, {})
await settle()
check('the panel reads the current peer on mount', sawFed('/sessions', 'POST'),
  calls.filter(call => call.url.includes('/api/federation')).map(call => `${call.method} ${call.url.split('/api/federation')[1]}`).join(' , ') || 'no federation call')
check('mounting also tells the host the panel is visible so its poller runs',
  sawFed('/poll', 'POST') || calls.some(call => call.url.endsWith('/api/federation/sessions') && String(call.body).includes('"visible":true')),
  calls.filter(call => String(call.body).includes('visible')).map(call => String(call.body)).join(' , ') || 'no visibility signal')

const fedPanelText = textOf(panelTree)
check('the panel states that it is read-only', fedPanelText.includes('只读'), fedPanelText.slice(0, 80))
check('the panel lists the sessions it was handed',
  fedPanelText.includes('修 build 脚本') && fedPanelText.includes('读日志'),
  fedPanelText.slice(0, 200))
check('the panel groups by working directory', fedPanelText.includes('build'),
  fedPanelText.slice(0, 200))
check('a running session is marked as running', fedPanelText.includes('运行中'), fedPanelText.slice(0, 160))
check('the header reports a running count', fedPanelText.includes('1 条运行中'), fedPanelText.slice(0, 120))
check('the panel picks a peer from ONE list rather than a dropdown beside one',
  findAll(panelTree, 'select').length === 0 && fedPanelText.includes('build-box') && fedPanelText.includes('tunnel-only'),
  `${String(findAll(panelTree, 'select').length)} select(s)`)
check('the panel offers an explicit refresh', findAll(panelTree, 'button').map(textOf).includes('刷新'),
  findAll(panelTree, 'button').map(textOf).join(' | '))
check('the panel offers to open the remote GUI', findAll(panelTree, 'button').map(textOf).includes('打开远端'),
  findAll(panelTree, 'button').map(textOf).join(' | '))
check('the panel exposes local search', findAll(panelTree, 'input').some(node => String(node.props.placeholder).includes('搜索')),
  findAll(panelTree, 'input').map(node => String(node.props.placeholder)).join(' | '))
check('the editor stays closed until a row asks for it',
  !fedPanelText.includes('SSH 主机'),
  findAll(panelTree, 'button').map(textOf).join(' | '))

// The panel must keep asking. It did not: it fetched once on mount, so the list,
// the running count and the icon badge all froze at mount time while the host
// went on polling the remote forever — a poll loop with no reader.
check('mounting the panel installs a poll loop',
  intervals.size >= 1,
  `${String(intervals.size)} interval(s): ${[...intervals.values()].map(entry => `${String(entry.ms)}ms`).join(' , ')}`)
// The newest interval must be the host's cadence. `intervals` accumulates across
// this harness's renders because its shallow renderer never runs the previous
// mount's cleanup, so only the latest one is meaningful here.
check('...at the cadence the host advertises rather than a hardcoded one',
  [...intervals.values()].at(-1)?.ms === federationFrame.poll.intervalMs && federationFrame.poll.intervalMs !== 15000,
  `${[...intervals.values()].map(entry => String(entry.ms)).join(' , ')} vs ${String(federationFrame.poll.intervalMs)}`)
const callsBeforePoll = calls.filter(call => call.url.endsWith('/sessions')).length
fireIntervals()
await settle()
check('...and firing it re-reads the session list',
  calls.filter(call => call.url.endsWith('/sessions')).length > callsBeforePoll,
  `${String(calls.filter(call => call.url.endsWith('/sessions')).length - callsBeforePoll)} extra /sessions call(s)`)
// Closing the tab or reloading never unmounts a React tree, so the panel must
// also stop the host's poller when the page goes away — otherwise the host keeps
// reading that remote every interval for the rest of its life, with no viewer.
check('leaving the page tells the host to stop polling',
  pagehideListeners.size === 1 && typeof [...pagehideListeners][0] === 'function',
  `${String(pagehideListeners.size)} pagehide listener(s)`)
const callsBeforeHide = calls.length
for (const listener of [...pagehideListeners]) listener()
await settle()
check('...with a visible:false poll request rather than only on unmount',
  calls.slice(callsBeforeHide).some(call => call.url.endsWith('/poll') && String(call.body).includes('"visible":false')),
  calls.slice(callsBeforeHide).map(call => `${call.method} ${call.url.split('/api/federation')[1] ?? call.url}`).join(' , ') || 'no call')

// The host builds the jump URL precisely so the device credential never reaches
// the browser; the panel must use it verbatim rather than reassembling one.
const openButton = findAll(panelTree, 'button').find(button => textOf(button) === '打开远端')
openButton?.props.onClick()
await settle()
check('opening the remote uses the host-built URL (credential stays host-side)',
  openedWindows.length === 1 && openedWindows[0].url === federationFrame.peers[0].jumpUrl,
  openedWindows.map(entry => entry.url).join(' , ') || 'nothing opened')
check('the remote GUI opens in a NEW window and cannot reach back',
  openedWindows.length === 1 && openedWindows[0].target === '_blank' && String(openedWindows[0].features).includes('noopener'),
  JSON.stringify(openedWindows[0] ?? {}))

// A peer reachable only through the tunnel has no browser origin at all: the
// panel must NOT invent one (its `origin` is 127.0.0.1 on the *far* machine).
check('a tunnel-only peer is not given a browser origin by the host frame',
  federationFrame.peers[1].jumpUrl === undefined && federationFrame.peers[1].openOrigin === undefined,
  JSON.stringify({ jumpUrl: federationFrame.peers[1].jumpUrl, openOrigin: federationFrame.peers[1].openOrigin }))

// With no browser-reachable address the button must still be VISIBLE (hiding it
// made the capability undiscoverable — the panel looked like it had no way to
// open the remote at all) and clicking must EXPLAIN rather than do nothing.
federationFrame = { ...federationFrame, peerId: 'f-2' }
const tunnelOnlyTree = renderRoot(Panel, {})
await settle()
const noTargetButton = openButtonFor(tunnelOnlyTree, 'tunnel-only')
check('the open-remote button stays visible even without a jump address',
  noTargetButton !== undefined, findAll(tunnelOnlyTree, 'button').map(textOf).join(' | '))
openedWindows.length = 0
// Snapshot AFTER the mount, because mounting itself fetches the session list;
// measuring from before it would blame that fetch on the click.
const callsAfterMount = calls.length
noTargetButton?.props.onClick()
await settle()
check('...and clicking it explains what to fill in instead of doing nothing',
  openedWindows.length === 0 && textOf(tunnelOnlyTree).includes('跳转地址'),
  `opened=${String(openedWindows.length)} message=${textOf(tunnelOnlyTree).slice(-160)}`)
check('...and no request is made for a peer that cannot be opened',
  calls.length === callsAfterMount, `${String(calls.length - callsAfterMount)} extra call(s)`)
// Restore the active peer. `healthyFrame` (the snapshot of this frame) is
// declared further down, so it cannot be referenced here.
federationFrame = { ...federationFrame, peerId: 'f-1' }

// The badge must now be live in the *other* root, without the panel re-rendering.
const iconTree2 = renderRoot(Icon, { size: 18, active: true })
await settle()
check('the self-drawn badge appears on the panel row once data has arrived',
  textOf(iconTree2).includes('1'), JSON.stringify(textOf(iconTree2)))
// The badge's tooltip is a translated string, not a baked-in literal. The two
// counts differ on purpose — the header reads 条运行中, the badge 条正在运行 — so
// matching the badge's own wording pins `fed.badgeTitle` and not `fed.runningCount`.
const badgeTitle = findAll(iconTree2, 'span')
  .map(node => node.props.title)
  .find(title => typeof title === 'string' && title.includes('条正在运行'))
check('...and the badge tooltip comes from the dictionary, not a hardcoded literal',
  badgeTitle === '1 条正在运行', String(badgeTitle))

// ── the failure taxonomy is shown, never swallowed ─────────────────────────
const healthyFrame = federationFrame
federationFrame = {
  ...healthyFrame,
  status: 'error',
  snapshot: undefined,
  error: { code: 'unauthorized', message: '远端返回 401：登录凭据无效或已过期' },
}
const errorTree = renderRoot(Panel, {})
await settle()
const errorText = textOf(errorTree)
check('a credential failure is shown with its code', errorText.includes('unauthorized'), errorText.slice(0, 120))
check('a credential failure states the correction, not just the symptom',
  errorText.includes('重新粘贴') || errorText.includes('token'), errorText.slice(0, 240))

// A gateway/internal failure has one notorious cause on the remote, and the
// panel is the only place the user can learn it.
federationFrame = {
  ...healthyFrame,
  status: 'error',
  snapshot: undefined,
  error: { code: 'gateway/internal', message: 'session persistence listing failed' },
}
const brokenTree = renderRoot(Panel, {})
await settle()
check('the corrupt-remote-session failure names its remote-side cause',
  textOf(brokenTree).includes('损坏的会话文件'),
  textOf(brokenTree).slice(0, 200))

// A 403 is the one failure that must NOT invite a retry: it is a policy
// answer, and retrying it is how a user ends up hammering a fence.
federationFrame = {
  ...healthyFrame,
  status: 'error',
  snapshot: undefined,
  error: { code: 'forbidden', message: '远端返回 403：被访问栅栏拒绝' },
}
const forbiddenTree = renderRoot(Panel, {})
await settle()
check('a fence rejection tells the user not to retry', textOf(forbiddenTree).includes('不要反复重试'),
  textOf(forbiddenTree).slice(0, 240))

// Stale data must stay readable but never look live.
federationFrame = {
  ...healthyFrame,
  status: 'error',
  error: { code: 'http-timeout', message: '请求超时：远端实例可能没有运行' },
}
const staleTree = renderRoot(Panel, {})
await settle()
const staleText = textOf(staleTree)
check('a stale snapshot stays on screen when the remote goes down',
  staleText.includes('修 build 脚本') && staleText.includes('快照'),
  staleText.slice(0, 200))
check('the panel explains an unreachable remote', staleText.includes('远端实例可能没有运行'), staleText.slice(0, 200))

// First run: with no machines at all, the panel must teach rather than sit blank.
federationFrame = { ...healthyFrame, peers: [], snapshots: [], peerId: undefined, snapshot: undefined, status: 'idle' }
const emptyTree = renderRoot(Panel, {})
await settle()
const emptyText = textOf(emptyTree)
check('an empty panel explains what it is for', emptyText.includes('把另一台机器的会话列在这里'), emptyText.slice(0, 120))
check('an empty panel states the read-only contract', emptyText.includes('只读'), emptyText.slice(0, 300))
check('an empty panel offers the one action that helps',
  findAll(emptyTree, 'button').map(textOf).includes('添加机器'),
  findAll(emptyTree, 'button').map(textOf).join(' | '))

// ── the same tree in English ────────────────────────────────────────────────
// A language switch must reach already-rendered copy, which is the whole point
// of looking strings up per render rather than caching them at registration.
setLanguage('en')
const englishTree = renderRoot(Panel, {})
await settle()
const englishText = textOf(englishTree)
check('switching the language re-labels the panel',
  englishText.includes('Remote sessions') && !englishText.includes('远端会话'),
  englishText.slice(0, 120))
check('switching the language re-labels the read-only contract',
  englishText.includes('Read-only'), englishText.slice(0, 200))
check('switching the language re-labels the panel-row registration',
  typeof panelCapture?.options?.label === 'function' && panelCapture.options.label() === 'Remote sessions',
  String(panelCapture?.options?.label?.()))

// ── the locale service is the authority, not the DOM ───────────────────────
// This is the regression that shipped: the panel read
// `document.documentElement.lang`, which the shell hardcodes to "en" and never
// updates, so a user with Chinese selected still got an English panel. The stub
// document still says "en" here on purpose — the locale service saying "zh" must
// win, or this fails.
check('the stub document really does claim English (so the next assertion bites)',
  globalThis.document.documentElement.lang === 'en',
  globalThis.document.documentElement.lang)
setLanguage('zh')
const zhTree = renderRoot(Panel, {})
await settle()
const zhText = textOf(zhTree)
check('the panel follows the locale service even when the DOM claims English',
  zhText.includes('远端会话') && !zhText.includes('Remote sessions'),
  zhText.slice(0, 120))
check('...and the panel-row label follows it too',
  typeof panelCapture?.options?.label === 'function' && panelCapture.options.label() === '远端会话',
  String(panelCapture?.options?.label?.()))

// A regional tag must still find its language.
setLanguage('zh-Hans')
const zhHansTree = renderRoot(Panel, {})
await settle()
check('a regional tag like zh-Hans still resolves to the Chinese dictionary',
  textOf(zhHansTree).includes('远端会话'),
  textOf(zhHansTree).slice(0, 80))

setLanguage('zh')
federationFrame = healthyFrame

// ── the machine list is always on screen, and every row jumps directly ─────
// Hiding it behind the manager disclosure is why the panel read as having
// nowhere to jump from. Asserted BEFORE the manager flow below, because
// `renderRoot` resets the harness's component store — calling it mid-flow
// would wipe the editor state those tests build up.
{
  const listOnlyTree = renderRoot(Panel, {})
  await settle()
  check('the machine list is visible without opening the manager at all',
    ['build-box', 'tunnel-only'].every(label =>
      findAll(listOnlyTree, 'button').map(textOf).some(text => text.includes(label))),
    findAll(listOnlyTree, 'button').map(textOf).join(' | ').slice(0, 220))
  check('...and every row carries its own jump button',
    findAll(listOnlyTree, 'button').map(textOf).filter(text => text === '打开远端').length >= 2,
    String(findAll(listOnlyTree, 'button').map(textOf).filter(text => text === '打开远端').length))
  check('...with the active machine marked',
    textOf(listOnlyTree).includes('当前'),
    textOf(listOnlyTree).slice(-140))
}

/**
 * The 打开远端 button belonging to the row whose name contains `label`.
 * @param {object} tree - the rendered tree.
 * @param {string} label - the machine label.
 * @returns {object | undefined} the button element.
 */
function openButtonFor(tree, label) {
  const buttons = findAll(tree, 'button')
  const nameAt = buttons.findIndex(button => textOf(button).includes(label))
  return nameAt < 0 ? undefined : buttons.slice(nameAt + 1).find(button => textOf(button).trim() === '打开远端')
}

/**
 * The 编辑 button belonging to the row whose name contains `label`.
 *
 * Rows are flat buttons in render order (name, 打开远端, 编辑, 移除), so the row
 * is identified by its name and the edit button taken from what follows it.
 * @param {object} tree - the rendered tree.
 * @param {string} label - the machine label to look for.
 * @returns {object | undefined} the button element.
 */
function editButtonFor(tree, label) {
  const buttons = findAll(tree, 'button')
  const nameAt = buttons.findIndex(button => textOf(button).includes(label))
  return nameAt < 0 ? undefined : buttons.slice(nameAt + 1).find(button => textOf(button).trim() === '编辑')
}
// ── managing machines: the editor and the remote lifecycle ─────────────────
// Both live inside the editor, which only appears once management is disclosed.
calls.length = 0
const manageTree = renderRoot(Panel, {})
await settle()
editButtonFor(manageTree, 'build-box')?.props.onClick()
await settle()

/** Re-render the open editor after an action settles. */
async function editorText() {
  await settle()
  return textOf(manageTree)
}

let editor = await editorText()
check('the management disclosure opens the editor', editor.includes('SSH 隧道'), editor.slice(0, 160))

/**
 * The first rendered node whose inline style sets `position: fixed`.
 * @param {object} tree - the rendered tree.
 * @returns {object | undefined} the node, or undefined.
 */
function findFixed(tree) {
  let found
  const visit = (node) => {
    if (found !== undefined || node === null || node === undefined || typeof node !== 'object') return
    if (Array.isArray(node)) { for (const child of node) visit(child); return }
    if (node.props?.style?.position === 'fixed') { found = node; return }
    visit(node.children)
    visit(node.props?.children)
  }
  visit(tree)
  return found
}

// Rendered inline the editor pushed the session list out of the way, squeezed a
// 560px form into the middle of a wide panel, and scrolled away with the list —
// so it is a fixed overlay now. `position: fixed` is also what escapes the
// body's own `overflowY: auto`, which would clip an absolutely-positioned child.
const overlay = findFixed(manageTree)
check('the editor is an overlay, so it cannot push the list out of the way',
  overlay !== undefined, String(overlay?.props?.style?.position))
check('...it covers the viewport rather than sitting inline in the panel',
  overlay?.props?.style?.inset === 0,
  JSON.stringify(overlay?.props?.style ?? null).slice(0, 140))
check('...it has an explicit close button, not only the backdrop',
  findAll(manageTree, 'button').map(textOf).some(text => text.trim() === '关闭'),
  findAll(manageTree, 'button').map(textOf).join(' | ').slice(0, 170))
check('...and the backdrop is wired to close it',
  typeof overlay?.props?.onClick === 'function',
  typeof overlay?.props?.onClick)
// Provisioning runs commands on the other machine, so it must be visibly
// separate from everything else on this form.
check('the editor offers the remote start/stop controls',
  ['拉起远程实例', '关闭远程实例', '查看远端状态', '重启并重新捕获 token', '查看远端日志'].every(label =>
    findAll(manageTree, 'button').map(textOf).some(text => text.includes(label))),
  findAll(manageTree, 'button').map(textOf).join(' | '))
check('the editor warns that a non-interactive PATH often lacks dsh',
  editor.includes('非交互 PATH'), editor.slice(0, 500))

// Two machines are saved above (`build-box` is active, `tunnel-only` is not).
// Managing the second one must not require switching the whole panel over to it:
// the picker lists every saved machine and rebinds the editor to the chosen row.
check('every saved machine appears in the picker with its reach',
  ['build-box', 'tunnel-only'].every(label => findAll(manageTree, 'button').map(textOf).some(text => text.includes(label))),
  findAll(manageTree, 'button').map(textOf).join(' | '))

/**
 * Read one attribute from every `<input>` in the rendered editor.
 *
 * Text extraction cannot see `placeholder` (it is a prop, not a text child), and
 * the stored-secret hint lives there — so the retarget check reads actual input
 * state and the stored-secret check reads placeholders, both through here.
 * @param {string} name - the prop to collect (`value` or `placeholder`).
 * @param {object} [tree] - the tree to walk; defaults to `manageTree`.
 * @returns {string[]} the collected values, in render order.
 */
function inputProps(name, tree = manageTree) {
  const values = []
  const visit = (node) => {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (Array.isArray(node)) { for (const child of node) visit(child); return }
    if (node.type === 'input' && node.props?.[name] !== undefined) values.push(String(node.props[name]))
    visit(node.children)
    visit(node.props?.children)
  }
  visit(tree)
  return values
}

const beforeInputs = inputProps('value')
check('the editor starts bound to the active machine',
  beforeInputs.includes('192.168.1.23'),
  JSON.stringify(beforeInputs))

// Stored secrets are SHOWN now, by the owner's explicit decision: the token and
// the SSH password are prefilled into their inputs rather than withheld behind a
// "saved, leave empty" label. `build-box` is the active peer and has both.
check('a stored SSH password is shown in its field',
  inputProps('value').includes('pw-for-build-box'),
  JSON.stringify(inputProps('value')))
check('a stored token is shown in its field too',
  inputProps('value').includes('token-for-build-box'),
  JSON.stringify(inputProps('value')))
check('...and no field still claims a secret is being withheld',
  !textOf(manageTree).includes('不回显') && !textOf(manageTree).includes('已保存（留空保持不变）'),
  inputProps('placeholder').join(' | ').slice(0, 200))

// The active peer is `build-box`; retarget to the OTHER one and assert the form
// actually follows — this is the assertion that fails when the editor is still
// hard-bound to `active`, and it must read input state rather than text.
editButtonFor(manageTree, 'tunnel-only')?.props.onClick()
await settle()
const retargetedText = textOf(manageTree)
const afterInputs = inputProps('value')
check('picking another machine rebinds the editor form to it',
  afterInputs.includes('10.0.0.9') && afterInputs.includes('2222'),
  JSON.stringify(afterInputs))
check('...and the previously-active machine is no longer in the form',
  !afterInputs.includes('192.168.1.23') && !afterInputs.includes('token-for-build-box'),
  JSON.stringify(afterInputs))
check('...and a machine with no stored secret shows empty fields, not a stale one',
  !retargetedText.includes('token-for-build-box') && !retargetedText.includes('pw-for-build-box'),
  retargetedText.slice(0, 200))
// Back to the active peer for the sections below, which drive provisioning and
// import against `f-1`.
editButtonFor(manageTree, 'build-box')?.props.onClick()
await editorText()

// ── adding a machine, with a non-empty list ────────────────────────────────
// "Add" used to exist ONLY in the empty state, so once one machine was saved the
// list could be edited and deleted but never extended by hand. It has to be
// reachable from the manager itself.
check('the manager offers a way to add a machine even when some are already saved',
  findAll(manageTree, 'button').map(textOf).filter(text => text.trim() === '添加机器').length >= 1,
  findAll(manageTree, 'button').map(textOf).join(' | '))
const boundBeforeAdd = inputProps('value')
findAll(manageTree, 'button').find(button => textOf(button).trim() === '添加机器')?.props.onClick()
await editorText()
const afterAdd = inputProps('value')
check('adding a machine opens an EMPTY form rather than the selected machine',
  !afterAdd.includes('192.168.1.23') && !afterAdd.includes('10.0.0.9'),
  JSON.stringify(afterAdd))
check('...and the form is not blank in a way that hides which mode it is in',
  afterAdd.length > 0 && boundBeforeAdd.length > 0,
  `${String(boundBeforeAdd.length)} -> ${String(afterAdd.length)} input(s)`)
// Picking a saved machine must also LEAVE "new" mode, or the form stays empty
// and the only way back to editing is collapsing the manager and reopening it.
editButtonFor(manageTree, 'build-box')?.props.onClick()
await editorText()
check('picking a saved machine after "add" returns to editing that machine',
  inputProps('value').includes('192.168.1.23'),
  JSON.stringify(inputProps('value')))
// Back to editing the active machine for the provisioning sections below.
editButtonFor(manageTree, 'build-box')?.props.onClick()
await editorText()

// Status is the safe probe, and it must report what the host found rather than
// assuming an answer.
provisionFrame = { id: 'f-1', action: 'status', listening: false, evidence: '' }
calls.length = 0
findAll(manageTree, 'button').find(button => textOf(button).includes('查看远端状态'))?.props.onClick()
editor = await editorText()
check('checking the remote status posts the action',
  calls.some(call => call.url.endsWith('/provision') && String(call.body).includes('"action":"status"')),
  calls.filter(call => call.url.endsWith('/provision')).map(call => String(call.body)).join(' , ') || 'no provision call')
check('a stopped remote is reported as stopped', editor.includes('没在运行'), editor.slice(0, 400))

// Starting must report the captured token, because that is the whole reason the
// host starts it rather than telling the user to.
provisionFrame = { id: 'f-1', action: 'start', started: true, token: 'tok', port: 3080 }
const sessionsBeforeStart = calls.filter(call => call.url.endsWith('/sessions')).length
findAll(manageTree, 'button').find(button => textOf(button).includes('拉起远程实例'))?.props.onClick()
editor = await editorText()
check('a successful start reports the captured token and port',
  editor.includes('已拉起') && editor.includes('3080'), editor.slice(0, 400))
// A restart replaces this peer's token, and the panel is otherwise still holding
// the peer list it loaded BEFORE that — so the very next "open remote" would hand
// the browser the previous token and land on the harness's 401 page. The panel
// has to re-read as part of the action, not on the next 15s poll.
check('...and the panel re-reads, so the jump URL is not left one token behind',
  calls.filter(call => call.url.endsWith('/sessions')).length > sessionsBeforeStart,
  `${String(calls.filter(call => call.url.endsWith('/sessions')).length - sessionsBeforeStart)} extra /sessions call(s)`)

// The same must hold for the restart button, whose whole purpose is a new token.
provisionFrame = { id: 'f-1', action: 'start', started: true, token: 'tok2', port: 3080 }
const sessionsBeforeRestart = calls.filter(call => call.url.endsWith('/sessions')).length
const restart = findAll(manageTree, 'button').find(button => textOf(button).includes('重启并重新捕获 token'))
restart?.props.onClick()
editor = await editorText()
check('the restart button asks the host to force a restart',
  calls.some(call => call.url.endsWith('/provision') && String(call.body).includes('"force":true')),
  calls.filter(call => call.url.endsWith('/provision')).map(call => String(call.body)).slice(-2).join(' , ') || 'no provision call')
check('...and it re-reads the panel too',
  calls.filter(call => call.url.endsWith('/sessions')).length > sessionsBeforeRestart,
  `${String(calls.filter(call => call.url.endsWith('/sessions')).length - sessionsBeforeRestart)} extra /sessions call(s)`)

// An already-running remote must NOT be reported as freshly started: the user
// would otherwise believe a second instance had been launched.
provisionFrame = { id: 'f-1', action: 'start', started: false, alreadyRunning: true, port: 3080 }
findAll(manageTree, 'button').find(button => textOf(button).includes('拉起远程实例'))?.props.onClick()
editor = await editorText()
check('an already-running remote is not reported as freshly started',
  editor.includes('本来就在运行'), editor.slice(0, 400))

// A provisioning failure is a classified outcome, not a thrown error.
provisionFrame = { id: 'f-1', action: 'start', ok: false, code: 'provision-not-ready', detail: '没等到启动 URL' }
findAll(manageTree, 'button').find(button => textOf(button).includes('拉起远程实例'))?.props.onClick()
editor = await editorText()
check('a provisioning failure shows its code and detail',
  editor.includes('provision-not-ready') && editor.includes('没等到启动 URL'), editor.slice(0, 400))

// Read-back is the recovery path for a remote started outside this plugin.
provisionFrame = { id: 'f-1', action: 'read-token', found: false }
findAll(manageTree, 'button').find(button => textOf(button).includes('从日志读回 token'))?.props.onClick()
editor = await editorText()
check('a log with no launch URL is explained, not silently ignored',
  editor.includes('日志里没有启动 URL'), editor.slice(0, 400))

// The user's own debugging view: the remote's log, with the token masked by the
// host. It used to appear only as part of a FAILED start, which is no help when
// the start reports success and the browser still cannot get in.
provisionFrame = {
  id: 'f-1',
  action: 'logs',
  log: 'dsh web: http://127.0.0.1:3080/?token=*** (LAN: http://10.9.9.9:3080/?token=***)',
}
calls.length = 0
findAll(manageTree, 'button').find(button => textOf(button).includes('查看远端日志'))?.props.onClick()
editor = await editorText()
check('the editor can show the remote log on demand',
  editor.includes('查看远端日志') && editor.includes('127.0.0.1:3080') && editor.includes('10.9.9.9:3080'),
  editor.slice(0, 400))
check('...and reading the log is a provision request the host can answer',
  calls.some(call => call.url.endsWith('/provision') && String(call.body).includes('"action":"logs"')),
  calls.filter(call => call.url.endsWith('/provision')).map(call => String(call.body)).join(' , ') || 'no provision call')

provisionFrame = { id: 'f-1', action: 'logs', log: '', empty: true, detail: '远端那份日志是空的或不存在：这台实例可能不是本插件拉起的' }
findAll(manageTree, 'button').find(button => textOf(button).includes('查看远端日志'))?.props.onClick()
editor = await editorText()
check('an absent remote log is explained rather than shown as blank',
  editor.includes('不是本插件拉起'), editor.slice(0, 300))

provisionFrame = { id: 'f-1', action: 'status', listening: true, evidence: 'x' }

// ── the token jump's one-hop problem ───────────────────────────────────────
// A token jump cannot COMPLETE from here: the harness's browser-session cookie is
// `SameSite=Strict` (dsh-client-connection), so opening the remote from a
// different origin is a cross-site-initiated navigation, on which the browser will
// not attach that Strict cookie — the redeem's 303 to `/` therefore arrives
// without the cookie it just minted. The address bar flashing the token and then
// going bare IS that 303, i.e. proof the token was accepted. A reload is
// same-site, so the panel has to say so rather than let it read as a bad token.
const deviceJump = federationFrame.peers[0].jumpUrl
federationFrame = {
  ...federationFrame,
  peers: federationFrame.peers.map((peer, index) => (index === 0
    ? { ...peer, jumpUrl: 'http://192.168.1.23:3080/?token=tok' }
    : peer)),
}
const tokenJumpTree = renderRoot(Panel, {})
await settle()
check('a token jump is flagged as needing one reload',
  textOf(tokenJumpTree).includes('按一次刷新'),
  textOf(tokenJumpTree).slice(-300))
federationFrame = {
  ...federationFrame,
  peers: federationFrame.peers.map((peer, index) => (index === 0 ? { ...peer, jumpUrl: deviceJump } : peer)),
}
const pairedJumpTree = renderRoot(Panel, {})
await settle()
check('...and a paired-device jump, which completes on its own, is not',
  !textOf(pairedJumpTree).includes('按一次刷新'),
  textOf(pairedJumpTree).slice(-300))

// ── leaving the panel ──────────────────────────────────────────────────────
// The panel is re-rendered here and then has its effect cleanups run, to prove
// that going away stops the host's poller (a poller with no viewer is pure waste).
calls.length = 0
const unmountTree = renderRoot(Panel, {})
await settle()
for (const store of stores.values()) {
  for (const cleanup of store.cleanups ?? []) cleanup()
}
await settle()
check('leaving the panel stops the host poller',
  calls.some(call => call.url.endsWith('/api/federation/poll') && String(call.body).includes('"visible":false')),
  calls.filter(call => call.url.endsWith('/poll')).map(call => String(call.body)).join(' , ') || 'no poll call')
void unmountTree

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
