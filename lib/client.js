/**
 * dsh-remote-switch — browser half.
 *
 * One sidebar footer entry beside Settings: a dropdown that opens another DSH
 * instance's official Web GUI in a new window, a list to manage the stored
 * instances, and a highlight for the instance you are currently in.
 *
 * The bundle is hand-written in the loader's lazy-CJS form (no build step):
 * executing it only registers a factory; `require('react')` resolves against
 * the shell's frozen platform module table.
 *
 * The registered module id MUST equal this package's `package.json` name — the
 * boot graph addresses the bundle by that name, so a mismatch leaves the entry
 * unloaded (and `scripts/verify-client.mjs` pins the two together).
 *
 * Opening an instance targets `<origin>/pair-app?device=<credential>`, the
 * cookieless landing, so it works without depending on any cookie this browser
 * holds. Every HTTP call this file makes goes to the instance it is already
 * running on: `/api/instance-switcher/*`.
 */
window.__ModuleLoader__.load({
	id: 'dsh-remote-switch',
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

		const React = require('react')
		const h = React.createElement

		/** Route family served by this plugin's host half. */
		const BASE = '/api/instance-switcher'

		/** Sidebar seat this entry occupies (declared by the official sidebar shell). */
		const SEAT = 'sidebar.footer.action'

		/** Services required by this plugin. */
		exports.inject = ['slots']

		/**
		 * Read the JSON body from one of our own routes.
		 * @param {string} path - route path.
		 * @param {RequestInit} [init] - fetch init.
		 * @returns {Promise<object>} the parsed body.
		 */
		async function api(path, init) {
			const response = await fetch(`${BASE}${path}`, {
				cache: 'no-store',
				headers: { 'content-type': 'application/json' },
				...init,
			})
			let body
			try {
				body = await response.json()
			} catch {
				throw new Error(`HTTP ${String(response.status)}`)
			}
			if (!response.ok) throw new Error(body?.hint ?? body?.error ?? `HTTP ${String(response.status)}`)
			return body
		}

		/**
		 * Whether this page is running on the instance's own loopback origin.
		 * @returns {boolean} true for 127.0.0.1/localhost/[::1].
		 */
		function isLocalPage() {
			const host = window.location.hostname
			return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'
		}

		/**
		 * Normalize an origin for comparison.
		 * @param {string} value - any URL or origin.
		 * @returns {string} the origin, or the input when it does not parse.
		 */
		function originOf(value) {
			try {
				return new URL(value).origin
			} catch {
				return value
			}
		}

		/**
		 * Localized "time ago" for a ms-epoch stamp.
		 * @param {number | undefined} value - the stamp.
		 * @returns {string} a short human string.
		 */
		function ago(value) {
			if (typeof value !== 'number' || !Number.isFinite(value)) return '从未'
			const seconds = Math.max(0, Math.round((Date.now() - value) / 1000))
			if (seconds < 60) return `${String(seconds)} 秒前`
			const minutes = Math.round(seconds / 60)
			if (minutes < 60) return `${String(minutes)} 分钟前`
			const hours = Math.round(minutes / 60)
			if (hours < 24) return `${String(hours)} 小时前`
			return `${String(Math.round(hours / 24))} 天前`
		}

		/** Inline styles built once from the live document. */
		const T = {
			text: 'var(--dsw-alias-label-primary, #1f2328)',
			muted: 'var(--dsw-alias-label-secondary, #6b7280)',
			border: 'var(--dsw-alias-border-l3, rgba(0,0,0,.14))',
			hover: 'var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.06))',
			active: 'var(--dsw-alias-interactive-bg-active, rgba(0,0,0,.10))',
			accent: 'var(--dsw-alias-label-primary, #1f2328)',
			ok: '#22a06b',
			bad: '#d14343',
			radius: '8px',
		}

		const button = {
			font: 'inherit',
			fontSize: '12px',
			lineHeight: '18px',
			padding: '3px 9px',
			borderRadius: '6px',
			border: `1px solid ${T.border}`,
			background: 'transparent',
			color: T.text,
			cursor: 'pointer',
			whiteSpace: 'nowrap',
		}

		const input = {
			font: 'inherit',
			fontSize: '12px',
			lineHeight: '18px',
			padding: '5px 8px',
			borderRadius: '6px',
			border: `1px solid ${T.border}`,
			background: 'transparent',
			color: T.text,
			width: '100%',
			boxSizing: 'border-box',
		}

		/**
		 * The URL that enters one instance's official GUI: the cookieless
		 * landing when a credential is stored, the bare origin otherwise.
		 *
		 * Pure and exported so the switch target can be pinned without a DOM.
		 * @param {object} row - the target row (`{ origin, credential?, local? }`).
		 * @returns {string} the URL to open.
		 */
		function entryUrlFor(row) {
			if (row.credential === undefined || row.credential === '') return `${row.origin}/`
			return `${row.origin}/pair-app?device=${encodeURIComponent(row.credential)}`
		}
		exports.__entryUrlFor = entryUrlFor

		/** A small round status dot. */
		function Dot(props) {
			const color = props.state === 'ok' ? T.ok : props.state === 'bad' ? T.bad : T.muted
			return h('span', {
				title: props.title,
				style: {
					width: 7,
					height: 7,
					borderRadius: '50%',
					background: color,
					display: 'inline-block',
					flex: 'none',
				},
			})
		}

		/**
		 * The sidebar entry: an icon button that opens the instance panel.
		 * @param {{ wide?: boolean }} props - the sidebar footer seat props.
		 * @returns {object} the element tree.
		 */
		function InstanceEntry(props) {
			const [open, setOpen] = React.useState(false)
			const [anchor, setAnchor] = React.useState(undefined)
			const trigger = React.useRef(null)
			const wide = props?.wide !== false

			/**
			 * Measure the trigger so the panel can be anchored in VIEWPORT
			 * coordinates. The panel is `position: fixed` on purpose: the
			 * sidebar clips and stacks its own children, so an absolutely
			 * positioned popover inside the footer gets cut off (and can end up
			 * behind the sidebar's own layer).
			 * @returns {void}
			 */
			const measure = () => {
				const node = trigger.current
				if (node === null || node === undefined || typeof node.getBoundingClientRect !== 'function') return
				const rect = node.getBoundingClientRect()
				setAnchor({ top: rect.top, left: rect.left, right: rect.right })
			}
			const toggle = () => {
				const next = !open
				if (next) measure()
				setOpen(next)
			}
			const close = () => { setOpen(false) }

			// Close on Escape — the keyboard equivalent of clicking away.
			React.useEffect(() => {
				if (!open) return undefined
				const onKey = (event) => { if (event?.key === 'Escape') close() }
				window.addEventListener('keydown', onKey)
				return () => { window.removeEventListener('keydown', onKey) }
			}, [open])

			React.useEffect(() => {
				if (!open) return undefined
				const onResize = () => { measure() }
				window.addEventListener('resize', onResize)
				window.addEventListener('scroll', onResize, true)
				return () => {
					window.removeEventListener('resize', onResize)
					window.removeEventListener('scroll', onResize, true)
				}
			}, [open])

			// Click-away catcher. An overlay rather than a document listener on
			// purpose: the panel is `position: fixed` and sits above the sidebar,
			// so a full-viewport layer placed under it catches every outside click
			// without racing React's event system, and the panel — a later sibling
			// with a higher z-index — still receives its own clicks.
			const overlay = open
				? h('div', {
					key: 'overlay',
					'aria-hidden': 'true',
					onClick: close,
					style: {
						position: 'fixed',
						top: 0,
						right: 0,
						bottom: 0,
						left: 0,
						zIndex: 2147482999,
						background: 'transparent',
					},
				})
				: null

			// Match the official sidebar footer buttons (the Settings trigger and
			// its neighbours): no border, transparent fill, a round icon button in
			// the collapsed rail, and a full-width 12px-radius row when wide. The
			// geometry mirrors `sidebar.footer.action`'s own occupants so this
			// entry does not stand out as a boxed button.
			const [hover, setHover] = React.useState(false)
			const triggerStyle = {
				font: 'inherit',
				fontSize: '14px',
				lineHeight: '20px',
				display: 'inline-flex',
				alignItems: 'center',
				border: 'none',
				cursor: 'pointer',
				color: open || hover ? T.text : T.muted,
				background: open ? T.active : hover ? T.hover : 'transparent',
				transition: 'background-color .12s, color .12s',
				...(wide
					? { borderRadius: '999px', flex: 'auto', justifyContent: 'flex-start', gap: '8px', width: 'auto', minWidth: 0, padding: '0 10px' }
					: { borderRadius: '50%', flex: 'none', justifyContent: 'center', width: '36px', height: '36px', padding: 0 }),
			}

			return h('div', { style: { display: 'flex', flex: wide ? 'auto' : 'none', minWidth: 0 } }, [
				overlay,
				h('button', {
					key: 'trigger',
					ref: trigger,
					type: 'button',
					title: '实例（在新窗口打开别的 DSH 实例）',
					'aria-label': '实例',
					onClick: toggle,
					onMouseEnter: () => { setHover(true) },
					onMouseLeave: () => { setHover(false) },
					style: triggerStyle,
				}, [
					h('span', { key: 'g', style: { fontSize: '16px', lineHeight: '20px', flex: 'none' } }, '🌐'),
					wide ? h('span', {
						key: 'l',
						style: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 },
					}, '实例') : null,
				]),
				open ? h(InstancePanel, { key: 'panel', anchor, onClose: close }) : null,
			])
		}

		/**
		 * The switcher panel: current instance, a selection box, and the list.
		 * @param {{ anchor?: { top: number, left: number, right: number }, onClose: () => void }} props - panel props.
		 * @returns {object} the element tree.
		 */
		function InstancePanel(props) {
			const [state, setState] = React.useState({ loading: true, local: undefined, peers: [], error: undefined })
			const [selected, setSelected] = React.useState('')
			const [status, setStatus] = React.useState({})
			const [busy, setBusy] = React.useState(false)
			const [message, setMessage] = React.useState('')
			const [form, setForm] = React.useState({ label: '', link: '' })
			const local = isLocalPage()

			const refresh = React.useCallback(() => {
				setState(current => ({ ...current, loading: true }))
				api('/peers')
					.then(body => {
						// Spread the whole frame so host-side additions (peersFile, …)
						// reach the panel without touching this line.
						setState({ ...body, loading: false, peers: body.peers ?? [], error: undefined })
					})
					.catch(error => { setState(current => ({ ...current, loading: false, error: String(error?.message ?? error) })) })
			}, [])

			// Fetch once on mount. `refresh` is a stable useCallback, so the empty
			// dependency list is what keeps this from re-running on every render.
			React.useEffect(() => { refresh() }, [])

			const here = originOf(window.location.href)
			// Only stored peers are listed. There is deliberately no synthesized
			// "本机" row: this panel belongs to the instance you are already
			// looking at, so a local entry would only point back at the same
			// origin (and on another machine it would point at that machine).
			const rows = state.peers

			const current = rows.find(row => originOf(row.origin) === here)

			React.useEffect(() => {
				if (selected === '' && rows.length > 0) setSelected(current?.id ?? rows[0].id)
			}, [rows, selected, current])

			/**
			 * Open one instance's official GUI in a NEW window.
			 *
			 * A new window rather than a same-tab navigation on purpose: this
			 * page and its switcher then survive the switch, so coming back is
			 * just focusing the original window. (A same-tab jump would unload
			 * this UI, and there is no way to come back from another machine
			 * once it is gone.)
			 * @param {object} row - the target row.
			 * @returns {void}
			 */
			const openInstance = (row) => {
				if (typeof row.id === 'string') {
					// Best-effort bookkeeping; the window must not wait on it.
					void api('/peers', { method: 'POST', body: JSON.stringify({ action: 'touch', id: row.id }) }).catch(() => {})
				}
				// 'noopener' keeps the opened instance from reaching back into
				// this window; the call is inside a click handler, so the popup
				// blocker allows it.
				window.open(entryUrlFor(row), '_blank', 'noopener,noreferrer')
			}

			const selectedRow = rows.find(row => row.id === selected)

			/**
			 * Probe one instance's reachability and credential liveness.
			 * @param {object} row - the row to probe.
			 * @returns {Promise<void>}
			 */
			const test = async (row) => {
				setStatus(current2 => ({ ...current2, [row.id]: { state: 'busy', text: '测试中…' } }))
				try {
					const result = await api('/test', { method: 'POST', body: JSON.stringify({ id: row.id }) })
					const text = !result.reachable
						? '不可达'
						: result.credentialLive === false
							? '凭据已失效'
							: `${String(result.latencyMs)}ms`
					setStatus(current2 => ({
						...current2,
						[row.id]: { state: result.reachable && result.credentialLive !== false ? 'ok' : 'bad', text },
					}))
				} catch (error) {
					setStatus(current2 => ({ ...current2, [row.id]: { state: 'bad', text: String(error?.message ?? error) } }))
				}
			}

			/**
			 * Add or replace one instance from the form.
			 * @returns {Promise<void>}
			 */
			const add = async () => {
				if (form.link.trim() === '') return
				setBusy(true)
				setMessage('')
				try {
					const body = await api('/peers', {
						method: 'POST',
						body: JSON.stringify({ action: 'add', link: form.link, label: form.label }),
					})
					setForm({ label: '', link: '' })
					setMessage(body.credentialStored
						? '已保存，并已取得配对凭据 — 可以直接切换'
						: '已保存（未带配对凭据：需要该浏览器此前登录过那台实例）')
					refresh()
				} catch (error) {
					setMessage(String(error?.message ?? error))
				} finally {
					setBusy(false)
				}
			}

			/**
			 * Remove one stored instance (never the local entry).
			 * @param {object} row - the row to drop.
			 * @returns {Promise<void>}
			 */
			const remove = async (row) => {
				if (!window.confirm(`从清单里移除「${row.label}」？\n（只影响本机清单，不会动对方实例上的记录）`)) return
				try {
					await api('/peers', { method: 'POST', body: JSON.stringify({ action: 'remove', id: row.id }) })
					refresh()
				} catch (error) {
					setMessage(String(error?.message ?? error))
				}
			}

			const showForm = local

			// Anchor in viewport coordinates, clamped so the panel never leaves
			// the window on a narrow sidebar. `position: fixed` escapes the
			// sidebar's own clipping and stacking.
			const viewportWidth = typeof window.innerWidth === 'number' ? window.innerWidth : 1024
			const viewportHeight = typeof window.innerHeight === 'number' ? window.innerHeight : 768
			const panelWidth = Math.min(320, Math.max(240, viewportWidth - 16))
			const anchor = props.anchor
			const left = anchor === undefined
				? Math.max(8, viewportWidth - panelWidth - 12)
				: Math.max(8, Math.min(anchor.left, viewportWidth - panelWidth - 8))
			const bottom = anchor === undefined
				? 72
				: Math.max(8, viewportHeight - anchor.top + 8)
			const maxHeight = Math.max(200, viewportHeight - bottom - 12)

			return h('div', {
				style: {
					position: 'fixed',
					left,
					bottom,
					width: panelWidth,
					maxHeight,
					overflowY: 'auto',
					zIndex: 2147483000,
					background: 'var(--dsw-specific-sidebar-fill, #fff)',
					color: T.text,
					border: `1px solid ${T.border}`,
					borderRadius: T.radius,
					boxShadow: '0 8px 28px rgba(0,0,0,.18)',
					padding: 12,
					display: 'flex',
					flexDirection: 'column',
					gap: 10,
				},
			}, [
				h('div', { key: 'head', style: { display: 'flex', alignItems: 'center', gap: 8 } }, [
					h('div', { key: 't', style: { fontSize: 13, fontWeight: 600, flex: 1 } }, '实例'),
					h('button', { key: 'x', type: 'button', onClick: props.onClose, style: { ...button, padding: '2px 7px' } }, '✕'),
				]),

				h('div', { key: 'now', style: { fontSize: 12, color: T.muted } },
					current === undefined
						? `当前：未知来源 ${here}`
						: `当前：${current.label}`),

				// Multi-instance selection box.
				h('div', { key: 'pick', style: { display: 'flex', flexDirection: 'column', gap: 4 } }, [
					h('label', { key: 'l', style: { fontSize: 12, color: T.muted } }, '打开实例（新窗口）'),
					h('div', { key: 'row', style: { display: 'flex', gap: 6 } }, [
						h('select', {
							key: 's',
							value: selected,
							onChange: event => { setSelected(event.target.value) },
							style: { ...input, flex: 1 },
						}, rows.map(row => h('option', {
							key: row.id,
							value: row.id,
						}, `${row.label} — ${originOf(row.origin).replace(/^https?:\/\//, '')}`))),
						h('button', {
							key: 'go',
							type: 'button',
							disabled: selectedRow === undefined,
							onClick: () => { if (selectedRow !== undefined) openInstance(selectedRow) },
							style: { ...button, fontWeight: 600, opacity: selectedRow === undefined ? 0.5 : 1 },
						}, '打开'),
					]),
				]),

				h('div', { key: 'list', style: { display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 190, overflowY: 'auto' } },
					rows.map(row => {
						const st = status[row.id]
						const active = originOf(row.origin) === here
						return h('div', {
							key: row.id,
							style: {
								display: 'flex',
								alignItems: 'center',
								gap: 6,
								padding: '5px 6px',
								borderRadius: 6,
								background: active ? T.active : 'transparent',
							},
						}, [
							h(Dot, { key: 'd', state: st?.state ?? 'idle', title: st?.text ?? '未测试' }),
							h('div', { key: 'm', style: { flex: 1, minWidth: 0 } }, [
								h('div', { key: 'n', style: { fontSize: 12, fontWeight: active ? 600 : 400, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } },
									`${row.label}`),
								h('div', { key: 'o', style: { fontSize: 11, color: T.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } },
									`${row.origin}${row.credential ? ' · 已存凭据' : ' · 无凭据'} · ${ago(row.lastUsedAt)}`),
								st?.text !== undefined && st.state !== 'idle'
									? h('div', { key: 'st', style: { fontSize: 11, color: st.state === 'bad' ? T.bad : T.muted } }, st.text)
									: null,
							]),
							h('button', {
								key: 't',
								type: 'button',
								title: '测试可达性与凭据',
								onClick: () => { void test(row) },
								disabled: !local,
								style: { ...button, padding: '2px 7px', opacity: local ? 1 : 0.5 },
							}, '测试'),
							active
								? h('span', { key: 'here', style: { fontSize: 11, color: T.muted } }, '当前')
								: h('button', {
									key: 'sw',
									type: 'button',
									title: '在新窗口打开这个实例',
									onClick: () => { openInstance(row) },
									style: { ...button, padding: '2px 7px' },
								}, '打开'),
							local
								? h('button', {
									key: 'rm',
									type: 'button',
									title: '从清单移除',
									onClick: () => { void remove(row) },
									style: { ...button, padding: '2px 7px' },
								}, '移除')
								: null,
						])
					}),
					rows.length === 0 ? h('div', { key: 'none', style: { fontSize: 12, color: T.muted } }, '还没有其他实例。') : null,
				),

				showForm ? h('div', { key: 'form', style: { borderTop: `1px solid ${T.border}`, paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 6 } }, [
					h('div', { key: 't', style: { fontSize: 12, fontWeight: 600 } }, '添加实例'),
					h('input', {
						key: 'label',
						value: form.label,
						placeholder: '名称（可空，默认用主机名）',
						onChange: event => { setForm(current2 => ({ ...current2, label: event.target.value })) },
						style: input,
					}),
					h('input', {
						key: 'link',
						value: form.link,
						placeholder: 'http://192.168.1.23:3080 或粘贴对方的配对链接',
						onChange: event => { setForm(current2 => ({ ...current2, link: event.target.value })) },
						style: input,
					}),
					h('div', { key: 'hint', style: { fontSize: 11, color: T.muted, lineHeight: 1.5 } },
						'对方的链接在它本机「远程访问」面板里点「复制链接」取得。粘贴带令牌的链接时，本插件会在后台替你兑换成凭据——不需要在这台机器上打开那个页面。'),
					h('div', { key: 'actions', style: { display: 'flex', gap: 6, justifyContent: 'flex-end' } }, [
						h('button', {
							key: 'add',
							type: 'button',
							disabled: busy || form.link.trim() === '',
							onClick: () => { void add() },
							style: { ...button, fontWeight: 600, opacity: busy || form.link.trim() === '' ? 0.5 : 1 },
						}, busy ? '处理中…' : '添加'),
					]),
				]) : h('div', { key: 'noloop', style: { fontSize: 11, color: T.muted, borderTop: `1px solid ${T.border}`, paddingTop: 8, lineHeight: 1.5 } },
					'添加/移除/测试只在 127.0.0.1 页面可用。'),

				message !== '' ? h('div', { key: 'msg', style: { fontSize: 11, color: T.muted, lineHeight: 1.5 } }, message) : null,
				state.error !== undefined ? h('div', { key: 'err', style: { fontSize: 11, color: T.bad } }, state.error) : null,
			])
		}

		/**
		 * Register the sidebar entry.
		 * @param {import('@deepseek-ai/cordis').Context} ctx - client root context.
		 * @returns {void}
		 */
		exports.apply = function apply(ctx) {
			ctx.slots.inject(SEAT, () => {
				let dispose
				try {
					dispose = ctx.slots.register({ name: SEAT, id: 'instance-switcher', order: 45 }, InstanceEntry)
				} catch {
					return () => {}
				}
				return () => { dispose() }
			})
		}

		return module.exports
	},
})
