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

		/** Route family serving the federation (remote-session) surface. */
		const FED = '/api/federation'

		/** Sidebar seat this entry occupies (declared by the official sidebar shell). */
		const SEAT = 'sidebar.footer.action'

		/**
		 * Global panel row the remote-session panel occupies. The sidebar draws
		 * the button and its label; this plugin supplies only the icon, and the
		 * click belongs to the sidebar (`selectPanel(id)`).
		 */
		const PANEL_SEAT = 'sidebar.panellist'

		/** Panel id, doubling as the `main` slot key the layout selects. */
		const PANEL_ID = 'federation-sessions'

		/** Row order among global panels; above the shipped ones (default 0). */
		const PANEL_ORDER = 20

		/** Locale namespace this package registers (see `registerLocale`). */
		const NS = 'dsh-remote-switch'

		/**
		 * Services required by this plugin.
		 *
		 * `locale` MUST be listed, not merely read: an undeclared service is not
		 * awaited and not guaranteed to be mounted as `ctx.locale`, so the panel
		 * silently falls back to its own heuristic — which read the static
		 * `index.html` `lang="en"` and made the whole UI English regardless of the
		 * user's setting. Every working locale-registering plugin in this profile
		 * declares it (dsh-pet, dsh-ssh, dsh-doctor, …).
		 */
		exports.inject = ['slots', 'locale']
		/**
		 * Copy for both shipped languages.
		 *
		 * Held in this file rather than a second module on purpose: the bundle is
		 * loaded as a single lazy-CJS factory with no build step, and its `require`
		 * only resolves against the shell's frozen platform table, so a sibling
		 * file would need a resolution path that nothing else here uses.
		 *
		 * Keys follow the two surfaces the plugin owns, so a reader can tell which
		 * panel a string belongs to: `switch.*` is the instance switcher, `fed.*`
		 * is the remote-session panel.
		 */
		const ZH = {
			'entry.title': '实例（在新窗口打开别的 DSH 实例）',
			'entry.label': '实例',
			'panel.title': '实例',
			'ago.never': '从未',
			'ago.now': '刚刚',
			'ago.seconds': '{n} 秒前',
			'ago.minutes': '{n} 分钟前',
			'ago.hours': '{n} 小时前',
			'ago.days': '{n} 天前',
			'switch.current': '当前：{label}',
			'switch.currentUnknown': '当前：未知来源 {origin}',
			'switch.openPick': '打开实例（新窗口）',
			'switch.open': '打开',
			'switch.untested': '未测试',
			'switch.hasCredential': ' · 已存凭据',
			'switch.noCredential': ' · 无凭据',
			'switch.testHint': '测试可达性与凭据',
			'switch.test': '测试',
			'switch.testing': '测试中…',
			'switch.unreachable': '不可达',
			'switch.credentialDead': '凭据已失效',
			'switch.here': '当前',
			'switch.openThis': '在新窗口打开这个实例',
			'switch.removeHint': '从清单移除',
			'switch.remove': '移除',
			'switch.removeConfirm': '从清单里移除「{label}」？\n（只影响本机清单，不会动对方实例上的记录）',
			'switch.empty': '还没有其他实例。',
			'switch.addTitle': '添加实例',
			'switch.addLabelPlaceholder': '名称（可空，默认用主机名）',
			'switch.addLinkPlaceholder': 'http://192.168.1.23:3080 或粘贴对方的配对链接',
			'switch.addHint': '对方的链接在它本机「远程访问」面板里点「复制链接」取得。粘贴带令牌的链接时，本插件会在后台替你兑换成凭据——不需要在这台机器上打开那个页面。',
			'switch.addBusy': '处理中…',
			'switch.add': '添加',
			'switch.added': '已保存，并已取得配对凭据 — 可以直接切换',
			'switch.addedNoCredential': '已保存（未带配对凭据：需要该浏览器此前登录过那台实例）',
			'switch.loopbackOnly': '添加/移除/测试只在 127.0.0.1 页面可用。',
			'fed.rowTitle': '远端会话',
			'fed.runningCount': '{n} 条运行中',
			'fed.noneRunning': '没有运行中的会话',
			'fed.badgeTitle': '{n} 条正在运行',
			'fed.noMachines': '还没有添加机器',
			'fed.refresh': '刷新',
			'fed.refreshing': '刷新中…',
			'fed.openRemote': '打开远端',
			'fed.openRemoteHint': '在新窗口打开远端首页',
			'fed.openRemoteHintNoTarget': '这台机器还没填「跳转地址」，所以现在打不开',
			'fed.noBrowserTarget': '这台机器没有浏览器能打开的地址，所以打不开。点这台机器的「编辑」，把「跳转地址」填成对方 dsh web 的地址（例如 http://{host}:{port}）。注意：SSH 隧道里的 127.0.0.1 指的是对方本机，不能用来打开页面。',
			'fed.noSessionUrl': '远端页面没有会话级网址，只能打开它的首页。',
			'fed.readonly': '只读：这里只显示对方机器上的会话清单与运行状态，不会向对方发指令，也不会改动对方任何数据。打开后由对方的 DSH 自己执行。',
			'fed.search': '搜索标题或目录',
			'fed.stale': '远端暂时读不到（{code}）：{message}。下面是 {ago}的快照。',
			'fed.staticTitle': '静态清单（远端实例没在运行）',
			'fed.staticBody': '以上是直接读对方磁盘上的会话文件得到的（{ago}）。所以：不知道哪条在跑；分不出空白会话；标题用目录名代替；时间是文件修改时间。归档的会话也会照常列出——归档状态存在对方内存里，这台机器读不到。',
			'fed.ungrouped': '未分组',
			'fed.ungroupedHint': '未归类到工作目录',
			'fed.count': '{n} 条',
			'fed.running': '运行中',
			'fed.idle': '空闲',
			'fed.updatedAt': '更新于 {time}',
			'fed.emptyAll': '对方没有可显示的会话（已排除子会话、空白会话与已归档会话）。',
			'fed.noMatch': '没有匹配的会话。',
			'fed.truncated': '对方共 {total} 条，这里只显示最近 {shown} 条。',
			'fed.savedCount': '{n} 台已保存',
			'fed.pickEdit': '点「编辑」改配置；点机器名把会话列表切过去',
			'fed.machinesTitle': '机器',
			'fed.current': '当前',
			'fed.editThis': '编辑这台机器的配置',
			'fed.switchTo': '把会话列表切到这台机器',
			'fed.edit': '编辑',
			'fed.emptyTitle': '把另一台机器的会话列在这里',
			'fed.emptyBody': '添加一台机器后，这个面板会定期读取它自己的会话清单（谁在跑、在哪个目录），点一条就在新窗口里打开那台机器的 DSH。',
			'fed.emptyHow': '两种接法：有 SSH 的机器填主机/用户名（走 SSH 隧道，不需要那台机器对外开端口）；没有 SSH 的机器填它的 http 地址并粘贴配对链接。列表是只读的——这里不会向对方发送任何指令。',
			'fed.addMachine': '添加机器',
			'fed.machineLine': '机器：{name}（{where}）',
			'err.ssh-auth': '检查用户名、私钥/密码是否对得上那台机器。',
			'err.ssh-host-key': '那台机器的主机密钥变了或与记录不符——确认是自己换过系统后再清除记录。',
			'err.ssh-timeout': 'SSH 连不上：确认地址、端口和防火墙。',
			'err.ssh-refused': '对方拒绝了 SSH 连接：确认 sshd 在跑、端口对。',
			'err.ssh-remote-not-listening': 'SSH 连上了，但对方机器自己的 127.0.0.1:3080 上没有服务——对方的 dsh web 没在跑。注意这个 127.0.0.1 指的是【对方机器】的回环，不是你这台：隧道就是把请求送进对方本机，所以不需要它对外开放端口。',
			'err.provision-dsh-not-found': '远端找不到 dsh 命令。交互式 SSH 能跑、插件却不行，通常是这个原因：nvm / volta / asdf 装的命令只对登录 shell 可见，而非交互 SSH 的 PATH 里没有。插件已改为用登录 shell 解析并启动；若仍失败，在那边执行 bash -lc "command -v dsh" 把绝对路径填进「远端 dsh 命令」。',
			'err.ssh-dns': '主机名解析不了：换 IP 试试。',
			'err.ssh-key-unreadable': '读不到私钥文件：检查路径和权限。',
			'err.http-timeout': '远端实例可能没在运行，或者端口不对。',
			'err.unauthorized': '登录凭据无效或已过期——点这台机器的「编辑」，重新粘贴对方启动时打印的 token。',
			'err.forbidden': '被远端的访问栅栏拒绝：地址/端口不对，或那台机器不允许这个来源访问。不要反复重试。',
			'err.not-found': '地址不是 DSH 的 API——端口错了，或对方没装需要的远端插件。',
			'err.no-credential': '这台机器还没有凭据：粘贴 token，或先在同名 origin 上完成配对。',
			'err.no-device-credential': '本机没有存那台机器的配对凭据：先在「实例」面板里配对一次。',
			'err.token-rejected': '远端拒绝了这枚 token（可能已过期，或该实例重启过）——请在远端重新取一次启动 URL。',
			'err.gateway/internal': '远端自己报错了（常见原因：那台机器上有一条损坏的会话文件，会让整个列表读不出来）。',
			'editor.channelSsh': 'SSH 隧道（推荐：对方不用对外开端口）',
			'editor.channelHttp': '直接连它的 http 地址',
			'editor.label': '名称（可空）',
			'editor.labelPlaceholder': '例如 build-box',
			'editor.host': 'SSH 主机',
			'editor.hostPlaceholder': '192.168.1.23 或主机名',
			'editor.user': '用户名',
			'editor.port': 'SSH 端口',
			'editor.keyPath': '私钥文件（推荐；填了就优先用它，下面的密码会被忽略）',
			'editor.remotePort': '对方 dsh web 端口',
			'editor.password': 'SSH 密码',
			'editor.passwordNew': '输入 SSH 密码（留空则只用私钥）',
			'editor.passwordStored': 'SSH 密码：已保存（留空保持不变）',
			'editor.token': 'token',
			'editor.tokenPlaceholder': '从对方启动输出里复制',
			'editor.tokenStored': 'token：已保存（留空保持不变）',
			'editor.secretStoredHint': '出于安全，已保存的凭据不回显',
			'editor.webOrigin': '跳转地址（选填：这台浏览器能打开的对方地址）',
			'editor.webOriginNote': '留空也能用：面板会正常列清单，只是「打开远端」不可用（SSH 隧道里的 127.0.0.1 是你这台机器上的地址，不能拿来打开对方页面）。',
			'editor.origin': '对方地址',
			'editor.auth': '凭据',
			'editor.authToken': '官方 token（对方启动时打印的链接里那串）',
			'editor.authDevice': 'device 配对凭据（复用本插件已配对的机器）',
			'editor.authNone': '无（只试连通性）',
			'editor.deviceNote': '要求对方装了远程访问插件，并且本机「实例」面板里已配对同一地址。这条通道的凭据等于对方的完全控制权。',
			'editor.save': '保存',
			'editor.titleNew': '添加机器',
			'editor.titleEdit': '编辑「{label}」',
			'editor.close': '关闭',
			'editor.saving': '保存中…',
			'editor.test': '测试连接',
			'editor.testOk': '连通：{ms}ms，凭据可用',
			'editor.testFail': '不通（{code}）：{detail}',
			'editor.forget': '清除凭据',
			'editor.forgetHint': '只清除本机缓存的登录凭据，不改动对方实例',
			'editor.remove': '移除这台机器',
			'editor.removeConfirm': '从本机清单里移除「{label}」？\n（只影响本机，不会动对方机器上的任何东西）',
			'editor.remoteHome': '远端 DSH_HOME（拉起/关闭用）',
			'editor.remoteHomePlaceholder': '~/.dsh',
			'editor.remoteDsh': '远端 dsh 命令（非交互 PATH 里常常找不到）',
			'editor.provision': '拉起远程实例',
			'editor.provisionRestart': '重启并重新捕获 token',
			'editor.provisionAlreadyHint': '远端每次启动都会换 token，所以本插件手里那份可能已经是更早一轮的。要重新拿到：点「重启并重新捕获 token」，或先「关闭远程实例」再「拉起远程实例」。',
			'editor.provisionStop': '关闭远程实例',
			'editor.provisionStatus': '查看远端状态',
			'editor.provisionToken': '从日志读回 token',
			'editor.provisionRunning': '远端实例在运行（{evidence}）',
			'editor.provisionStopped': '远端实例没在运行',
			'editor.provisionUnknown': '无法判断远端实例是否在运行（{evidence}）——别把它当成「没在跑」',
			'editor.provisionLog': '远端日志末尾（真正的原因通常在这里）：',
			'editor.provisionStarted': '已拉起，并已取得 token（端口 {port}）',
			'editor.provisionAlready': '远端实例本来就在运行，没有重复启动',
			'editor.provisionStoppedOk': '已关闭远端实例',
			'editor.provisionStopNone': '没有找到运行中的远端实例',
			'editor.provisionTokenOk': '已从日志读回 token',
			'editor.provisionTokenNone': '日志里没有启动 URL：那台实例可能不是本插件拉起的',
			'editor.saved': '已保存。',
			'editor.removed': '已移除。',
			'editor.forgotten': '已清除本机缓存的凭据（机器本身还在清单里）。',
		}

		/** English copy; key set must match {@link ZH}. */
		const EN = {
			'entry.title': 'Instances (open another DSH instance in a new window)',
			'entry.label': 'Instances',
			'panel.title': 'Instances',
			'ago.never': 'never',
			'ago.now': 'just now',
			'ago.seconds': '{n}s ago',
			'ago.minutes': '{n}m ago',
			'ago.hours': '{n}h ago',
			'ago.days': '{n}d ago',
			'switch.current': 'Current: {label}',
			'switch.currentUnknown': 'Current: unknown origin {origin}',
			'switch.openPick': 'Open instance (new window)',
			'switch.open': 'Open',
			'switch.untested': 'not tested',
			'switch.hasCredential': ' · credential stored',
			'switch.noCredential': ' · no credential',
			'switch.testHint': 'Test reachability and credential',
			'switch.test': 'Test',
			'switch.testing': 'Testing…',
			'switch.unreachable': 'unreachable',
			'switch.credentialDead': 'credential expired',
			'switch.here': 'current',
			'switch.openThis': 'Open this instance in a new window',
			'switch.removeHint': 'Remove from the list',
			'switch.remove': 'Remove',
			'switch.removeConfirm': 'Remove "{label}" from the list?\n(This only affects the local list; nothing on that instance is touched.)',
			'switch.empty': 'No other instances yet.',
			'switch.addTitle': 'Add an instance',
			'switch.addLabelPlaceholder': 'Name (optional; defaults to the host name)',
			'switch.addLinkPlaceholder': 'http://192.168.1.23:3080, or paste their pairing link',
			'switch.addHint': 'Get the link from "Copy link" in that instance\'s own Remote Access panel. When you paste a link carrying a token, this plugin redeems it for a credential in the background — you do not need to open that page on this machine.',
			'switch.addBusy': 'Working…',
			'switch.add': 'Add',
			'switch.added': 'Saved with a pairing credential — ready to switch',
			'switch.addedNoCredential': 'Saved without a pairing credential: this browser must have signed in to that instance before',
			'switch.loopbackOnly': 'Adding, removing, and testing work only from a 127.0.0.1 page.',
			'fed.rowTitle': 'Remote sessions',
			'fed.runningCount': '{n} running',
			'fed.noneRunning': 'nothing running',
			'fed.badgeTitle': '{n} running',
			'fed.noMachines': 'No machines added yet',
			'fed.refresh': 'Refresh',
			'fed.refreshing': 'Refreshing…',
			'fed.openRemote': 'Open remote',
			'fed.openRemoteHint': 'Open the remote home in a new window',
			'fed.openRemoteHintNoTarget': 'This machine has no "jump address" yet, so nothing can be opened',
			'fed.noBrowserTarget': 'This machine has no browser-reachable address, so nothing can be opened. Use "Edit" on its row and set "jump address" to the remote dsh web address (e.g. http://{host}:{port}). Note: the 127.0.0.1 inside an SSH tunnel is the REMOTE machine and cannot be opened from here.',
			'fed.noSessionUrl': 'The remote GUI has no per-session URL, so this opens its home page.',
			'fed.readonly': 'Read-only: this lists the other machine\'s sessions and running state. It sends no commands and changes nothing over there; opening a session runs on that machine\'s own DSH.',
			'fed.search': 'Search title or directory',
			'fed.stale': 'The remote is unreachable ({code}): {message}. Below is the snapshot from {ago}.',
			'fed.staticTitle': 'Static listing (the remote instance is not running)',
			'fed.staticBody': 'These rows come from reading that machine\'s session files directly ({ago}). So: nothing is known about what is running; blank sessions cannot be told apart; titles fall back to the directory name; and the time shown is the file\'s modification time. Archived sessions stay listed too — that state lives in the remote process\'s memory and is unreadable from here.',
			'fed.ungrouped': 'Ungrouped',
			'fed.ungroupedHint': 'Not filed under a working directory',
			'fed.count': '{n}',
			'fed.running': 'running',
			'fed.idle': 'idle',
			'fed.updatedAt': 'updated {time}',
			'fed.emptyAll': 'That machine has no displayable sessions (subagent, blank, and archived sessions are excluded).',
			'fed.noMatch': 'Nothing matches.',
			'fed.truncated': 'That machine has {total}; showing the most recent {shown}.',
			'fed.savedCount': '{n} saved',
			'fed.pickEdit': 'Use "Edit" to change a machine; click its name to switch the list to it',
			'fed.machinesTitle': 'Machines',
			'fed.current': 'active',
			'fed.editThis': 'Edit this machine\'s settings',
			'fed.switchTo': 'Switch the session list to this machine',
			'fed.edit': 'Edit',
			'fed.emptyTitle': 'List another machine\'s sessions here',
			'fed.emptyBody': 'Once a machine is added, this panel polls its session list (what is running, in which directory) and opens that machine\'s DSH in a new window when you click a row.',
			'fed.emptyHow': 'Two ways in: with SSH, enter host and user (the tunnel means that machine needs no exposed port); without SSH, enter its http address and paste a pairing link. The list is read-only — nothing here sends it commands.',
			'fed.addMachine': 'Add a machine',
			'fed.machineLine': 'Machine: {name} ({where})',
			'err.ssh-auth': 'Check the user name and the key or password against that machine.',
			'err.ssh-host-key': 'That machine\'s host key changed or does not match the record — confirm you rebuilt it before clearing the record.',
			'err.ssh-timeout': 'SSH is unreachable: check the address, port, and firewall.',
			'err.ssh-refused': 'SSH was refused: confirm sshd is running on the right port.',
			'err.ssh-remote-not-listening': 'SSH connected, but nothing is listening on the REMOTE machine\'s own 127.0.0.1:3080 — its dsh web is not running. Note that 127.0.0.1 here is the remote machine\'s loopback, not yours: that is exactly how the tunnel reaches it without exposing a port.',
			'err.provision-dsh-not-found': 'The remote cannot find the dsh command. If interactive SSH works but the plugin does not, this is usually why: commands installed by nvm / volta / asdf are visible only to a login shell, and a non-interactive SSH PATH does not include them. The plugin now resolves and launches through a login shell; if that still fails, run bash -lc "command -v dsh" there and put the absolute path in "remote dsh command".',
			'err.ssh-dns': 'The host name does not resolve: try an IP address.',
			'err.ssh-key-unreadable': 'The private key file cannot be read: check its path and permissions.',
			'err.http-timeout': 'The remote instance is probably not running, or the port is wrong.',
			'err.unauthorized': 'The credential is invalid or expired — use "Edit" on that machine\'s row and paste the token from its startup output again.',
			'err.forbidden': 'The remote\'s access fence refused this: wrong address or port, or that machine does not allow this origin. Do not keep retrying.',
			'err.not-found': 'That address is not a DSH API: wrong port, or the remote plugin is missing.',
			'err.no-credential': 'This machine has no credential yet: paste a token, or pair the same origin first.',
			'err.no-device-credential': 'No paired credential is stored for that machine: pair it once from the "Instances" panel.',
			'err.token-rejected': 'The remote rejected this token (expired, or that instance restarted) — fetch a fresh launch URL from that machine.',
			'err.gateway/internal': 'The remote reported its own failure. A common cause is one corrupt session file on that machine, which breaks its whole list.',
			'editor.channelSsh': 'SSH tunnel (recommended: no exposed port needed)',
			'editor.channelHttp': 'Connect to its http address directly',
			'editor.label': 'Name (optional)',
			'editor.labelPlaceholder': 'e.g. build-box',
			'editor.host': 'SSH host',
			'editor.hostPlaceholder': '192.168.1.23 or a host name',
			'editor.user': 'User name',
			'editor.port': 'SSH port',
			'editor.keyPath': 'Private key file (preferred; when set it is used and the password below is ignored)',
			'editor.remotePort': 'Remote dsh web port',
			'editor.password': 'SSH password',
			'editor.webOrigin': 'Jump address (optional: where this browser can open that machine)',
			'editor.webOriginNote': 'Leaving this empty still works: the panel lists sessions, only "Open remote" is unavailable (127.0.0.1 inside an SSH tunnel is an address on THIS machine and would open the wrong page).',
			'editor.origin': 'Remote address',
			'editor.auth': 'Credential',
			'editor.authToken': 'Official token (the one in that machine\'s startup URL)',
			'editor.authDevice': 'Paired device credential (reuse a machine this plugin already paired)',
			'editor.authNone': 'None (reachability only)',
			'editor.passwordNew': 'Enter the SSH password (leave empty to use the key only)',
			'editor.passwordStored': 'SSH password: saved (leave empty to keep it)',
			'editor.token': 'token',
			'editor.tokenPlaceholder': 'Copy it from that machine\'s startup output',
			'editor.tokenStored': 'token: saved (leave empty to keep it)',
			'editor.secretStoredHint': 'Stored credentials are never echoed back, for safety',
			'editor.deviceNote': 'Requires the remote-access plugin on that machine, and the same address paired from this machine\'s "Instances" panel. This credential is full control over that instance.',
			'editor.save': 'Save',
			'editor.titleNew': 'Add a machine',
			'editor.titleEdit': 'Edit "{label}"',
			'editor.close': 'Close',
			'editor.saving': 'Saving…',
			'editor.test': 'Test connection',
			'editor.testOk': 'Reachable: {ms}ms, credential works',
			'editor.testFail': 'Failed ({code}): {detail}',
			'editor.forget': 'Clear credential',
			'editor.forgetHint': 'Clears only the locally cached sign-in; nothing on that instance changes',
			'editor.remove': 'Remove this machine',
			'editor.removeConfirm': 'Remove "{label}" from the local list?\n(Only this machine is affected; nothing over there changes.)',
			'editor.remoteHome': 'Remote DSH_HOME (for start/stop)',
			'editor.remoteHomePlaceholder': '~/.dsh',
			'editor.remoteDsh': 'Remote dsh command (often missing from a non-interactive PATH)',
			'editor.provision': 'Start the remote instance',
			'editor.provisionRestart': 'Restart and re-capture the token',
			'editor.provisionAlreadyHint': 'The remote prints a new token on every boot, so the one this plugin holds may be from an earlier one. To get the current one: press "Restart and re-capture the token", or "Stop the remote instance" and then start it again.',
			'editor.provisionStop': 'Stop the remote instance',
			'editor.provisionStatus': 'Check remote status',
			'editor.provisionToken': 'Read the token back from the log',
			'editor.provisionRunning': 'The remote instance is running ({evidence})',
			'editor.provisionStopped': 'The remote instance is not running',
			'editor.provisionUnknown': 'Cannot tell whether the remote instance is running ({evidence}) — do not read this as "not running"',
			'editor.provisionLog': 'Tail of the remote log (the real cause is usually here):',
			'editor.provisionStarted': 'Started, and the token was captured (port {port})',
			'editor.provisionAlready': 'The remote instance was already running; nothing was restarted',
			'editor.provisionStoppedOk': 'Stopped the remote instance',
			'editor.provisionStopNone': 'No running remote instance was found',
			'editor.provisionTokenOk': 'Token read back from the log',
			'editor.provisionTokenNone': 'The log has no launch URL: that instance was probably not started by this plugin',
			'editor.saved': 'Saved.',
			'editor.removed': 'Removed.',
			'editor.forgotten': 'Cleared the credential cached on this machine (the machine itself is still in the list).',
		}

		/**
		 * Active dictionary, resolved from the registered locale when one is
		 * present and from the document language otherwise.
		 *
		 * The panel can render before (or without) the locale service — a bare
		 * composition, a test harness — so this must never depend on it.
		 * @type {Record<string, string>}
		 */
		let dictionary = ZH
		/** Translate function handed to every component; rebound by `registerLocale`. */
		let t = (key, params) => interpolate(ZH[key] ?? key, params)

		/**
		 * Substitute `{name}` placeholders.
		 * @param {string} text - the template.
		 * @param {Record<string, unknown>} [params] - values.
		 * @returns {string} the filled text.
		 */
		function interpolate(text, params) {
			if (params === undefined) return text
			let out = text
			for (const [name, value] of Object.entries(params)) out = out.replaceAll(`{${name}}`, String(value))
			return out
		}

		/**
		 * Pick the dictionary from `ctx.locale` when it is available, and fall
		 * back to the document language.
		 *
		 * Registering is what makes the copy follow the app's language setting;
		 * the fallback is what keeps the panel readable when this plugin is
		 * composed without the locale service.
		 * @param {import('@deepseek-ai/cordis').Context} ctx - client root context.
		 * @returns {void}
		 */
		function registerLocale(ctx) {
			const locale = ctx.locale ?? ctx.get?.('locale')

			/**
			 * Read the shell's active language, or undefined when unknown.
			 *
			 * The `locale` SERVICE is the authority: `getLocale()` returns
			 * `{ active, locales, revision }`, and `active` already reflects the
			 * user's saved preference and their browser tags. Reading
			 * `document.documentElement.lang` instead is a trap — the shipped
			 * `index.html` hardcodes `lang="en"` and the frontend never updates it,
			 * so that attribute reports English no matter which language was picked.
			 * @returns {string | undefined} the active locale id.
			 */
			const activeLanguage = () => {
				try {
					const snapshot = locale?.getLocale?.() ?? locale?.getSnapshot?.()
					const active = snapshot?.active
					if (typeof active === 'string' && active !== '') return active
				} catch {
					/* fall through to the document hint */
				}
				// Last resort: only trust the document when it says something other
				// than the static `en` default, which carries no information.
				const lang = typeof document !== 'undefined' && document.documentElement
					? document.documentElement.lang
					: ''
				return typeof lang === 'string' && lang.toLowerCase().startsWith('en') ? 'en' : 'zh'
			}

			/**
			 * Pick the dictionary for one active locale id. `zh-Hans`, `zh-CN`, and
			 * `zh` all resolve to Chinese, so a regional tag still finds its language.
			 * @param {string | undefined} active - the active locale id.
			 * @returns {Record<string, string>} the dictionary.
			 */
			const dictionaryFor = (active) => {
				const id = typeof active === 'string' ? active.toLowerCase() : ''
				if (id.startsWith('en')) return EN
				return ZH
			}

			try {
				if (locale !== undefined && typeof locale.register === 'function') {
					// Both dictionaries in one call: the registry rejects a namespace
					// whose shipped languages disagree on their key sets, so a
					// half-translated addition fails at registration.
					ctx.effect?.(() => locale.register(NS, { zh: ZH, en: EN }))
					const bound = typeof locale.bind === 'function' ? locale.bind(NS) : undefined
					const sync = () => { dictionary = dictionaryFor(activeLanguage()) }
					t = (key, params) => {
						let text
						try {
							text = bound === undefined ? undefined : bound(key, params)
						} catch {
							text = undefined
						}
						// A bound miss returns the key itself; prefer our own dictionary
						// so a partial registration cannot blank the panel.
						if (typeof text !== 'string' || text === key) {
							sync()
							text = dictionary[key] ?? ZH[key] ?? key
						}
						return interpolate(text, params)
					}
					sync()
					if (typeof locale.subscribe === 'function') {
						ctx.effect?.(() => locale.subscribe(sync))
					}
					return
				}
			} catch {
				/* the locale service is absent or shaped differently — use the fallback */
			}
			dictionary = dictionaryFor(activeLanguage())
			t = (key, params) => interpolate(dictionary[key] ?? ZH[key] ?? key, params)
		}

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
		 * Read the JSON body from one of the federation routes.
		 * @param {string} path - route path under `/api/federation`.
		 * @param {object} [body] - JSON body to POST.
		 * @returns {Promise<object>} the parsed body.
		 */
		async function fed(path, body) {
			const response = await fetch(`${FED}${path}`, {
				cache: 'no-store',
				headers: { 'content-type': 'application/json' },
				...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
			})
			let payload
			try {
				payload = await response.json()
			} catch {
				throw new Error(`HTTP ${String(response.status)}`)
			}
			if (!response.ok) throw new Error(payload?.hint ?? payload?.error ?? `HTTP ${String(response.status)}`)
			return payload
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
			if (typeof value !== 'number' || !Number.isFinite(value)) return t('ago.never')
			const seconds = Math.max(0, Math.round((Date.now() - value) / 1000))
			if (seconds < 60) return t('ago.seconds', { n: seconds })
			const minutes = Math.round(seconds / 60)
			if (minutes < 60) return t('ago.minutes', { n: minutes })
			const hours = Math.round(minutes / 60)
			if (hours < 24) return t('ago.hours', { n: hours })
			return t('ago.days', { n: Math.round(hours / 24) })
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
					title: t('entry.title'),
					'aria-label': t('entry.label'),
					onClick: toggle,
					onMouseEnter: () => { setHover(true) },
					onMouseLeave: () => { setHover(false) },
					style: triggerStyle,
				}, [
					h('span', { key: 'g', style: { fontSize: '16px', lineHeight: '20px', flex: 'none' } }, '🌐'),
					wide ? h('span', {
						key: 'l',
						style: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 },
					}, t('entry.label')) : null,
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
				setStatus(current2 => ({ ...current2, [row.id]: { state: 'busy', text: t('switch.testing') } }))
				try {
					const result = await api('/test', { method: 'POST', body: JSON.stringify({ id: row.id }) })
					const text = !result.reachable
						? t('switch.unreachable')
						: result.credentialLive === false
							? t('switch.credentialDead')
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
						? t('switch.added')
						: t('switch.addedNoCredential'))
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
				if (!window.confirm(t('switch.removeConfirm', { label: row.label }))) return
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
					h('div', { key: 't', style: { fontSize: 13, fontWeight: 600, flex: 1 } }, t('panel.title')),
					h('button', { key: 'x', type: 'button', onClick: props.onClose, style: { ...button, padding: '2px 7px' } }, '✕'),
				]),

				h('div', { key: 'now', style: { fontSize: 12, color: T.muted } },
					current === undefined
						? t('switch.currentUnknown', { origin: here })
						: t('switch.current', { label: current.label })),

				// Multi-instance selection box.
				h('div', { key: 'pick', style: { display: 'flex', flexDirection: 'column', gap: 4 } }, [
					h('label', { key: 'l', style: { fontSize: 12, color: T.muted } }, t('switch.openPick')),
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
						}, t('switch.open')),
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
							h(Dot, { key: 'd', state: st?.state ?? 'idle', title: st?.text ?? t('switch.untested') }),
							h('div', { key: 'm', style: { flex: 1, minWidth: 0 } }, [
								h('div', { key: 'n', style: { fontSize: 12, fontWeight: active ? 600 : 400, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } },
									`${row.label}`),
								h('div', { key: 'o', style: { fontSize: 11, color: T.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } },
									`${row.origin}${row.credential ? t('switch.hasCredential') : t('switch.noCredential')} · ${ago(row.lastUsedAt)}`),
								st?.text !== undefined && st.state !== 'idle'
									? h('div', { key: 'st', style: { fontSize: 11, color: st.state === 'bad' ? T.bad : T.muted } }, st.text)
									: null,
							]),
							h('button', {
								key: 't',
								type: 'button',
								title: t('switch.testHint'),
								onClick: () => { void test(row) },
								disabled: !local,
								style: { ...button, padding: '2px 7px', opacity: local ? 1 : 0.5 },
							}, t('switch.test')),
							active
								? h('span', { key: 'here', style: { fontSize: 11, color: T.muted } }, t('switch.here'))
								: h('button', {
									key: 'sw',
									type: 'button',
									title: t('switch.openThis'),
									onClick: () => { openInstance(row) },
									style: { ...button, padding: '2px 7px' },
								}, t('switch.open')),
							local
								? h('button', {
									key: 'rm',
									type: 'button',
									title: t('switch.removeHint'),
									onClick: () => { void remove(row) },
									style: { ...button, padding: '2px 7px' },
								}, t('switch.remove'))
								: null,
						])
					}),
					rows.length === 0 ? h('div', { key: 'none', style: { fontSize: 12, color: T.muted } }, t('switch.empty')) : null,
				),

				showForm ? h('div', { key: 'form', style: { borderTop: `1px solid ${T.border}`, paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 6 } }, [
					h('div', { key: 't', style: { fontSize: 12, fontWeight: 600 } }, t('switch.addTitle')),
					h('input', {
						key: 'label',
						value: form.label,
						placeholder: t('switch.addLabelPlaceholder'),
						onChange: event => { setForm(current2 => ({ ...current2, label: event.target.value })) },
						style: input,
					}),
					h('input', {
						key: 'link',
						value: form.link,
						placeholder: t('switch.addLinkPlaceholder'),
						onChange: event => { setForm(current2 => ({ ...current2, link: event.target.value })) },
						style: input,
					}),
					h('div', { key: 'hint', style: { fontSize: 11, color: T.muted, lineHeight: 1.5 } },
						t('switch.addHint')),
					h('div', { key: 'actions', style: { display: 'flex', gap: 6, justifyContent: 'flex-end' } }, [
						h('button', {
							key: 'add',
							type: 'button',
							disabled: busy || form.link.trim() === '',
							onClick: () => { void add() },
							style: { ...button, fontWeight: 600, opacity: busy || form.link.trim() === '' ? 0.5 : 1 },
						}, busy ? t('switch.addBusy') : t('switch.add')),
					]),
				]) : h('div', { key: 'noloop', style: { fontSize: 11, color: T.muted, borderTop: `1px solid ${T.border}`, paddingTop: 8, lineHeight: 1.5 } },
					t('switch.loopbackOnly')),

				message !== '' ? h('div', { key: 'msg', style: { fontSize: 11, color: T.muted, lineHeight: 1.5 } }, message) : null,
				state.error !== undefined ? h('div', { key: 'err', style: { fontSize: 11, color: T.bad } }, state.error) : null,
			])
		}

		/**
		 * The sidebar icon for the remote-session panel.
		 *
		 * The sidebar owns the button, its label, and the click; this component
		 * only draws the glyph — plus the change badge, which must be self-drawn
		 * because the owner props carry nothing but `{ size, active }`.
		 *
		 * The badge counts *running* sessions, which is the fact the row itself
		 * cannot express: a glance at the rail should say "something is working
		 * over there" without opening the panel.
		 *
		 * It subscribes to its own store rather than reading the panel's state,
		 * because the icon and the panel are rendered by different owners — the
		 * sidebar's row and the centre column — so the panel re-rendering does
		 * nothing for this component.
		 * @param {{ size?: number, active?: boolean }} props - owner props.
		 * @returns {object} the element tree.
		 */
		function FederationIcon(props) {
			const size = typeof props?.size === 'number' ? props.size : 16
			const running = React.useSyncExternalStore(
				subscribeFederation,
				getFederationRunningCount,
				getFederationRunningCount,
			)
			return h('span', {
				style: {
					display: 'inline-flex',
					position: 'relative',
					width: size,
					height: size,
					alignItems: 'center',
					justifyContent: 'center',
					fontSize: size,
					lineHeight: 1,
				},
			}, [
				h('span', { key: 'g', 'aria-hidden': 'true' }, '🖧'),
				running > 0
					? h('span', {
						key: 'b',
						title: t('fed.badgeTitle', { n: running }),
						style: {
							position: 'absolute',
							top: -4,
							right: -6,
							minWidth: 14,
							height: 14,
							padding: '0 3px',
							borderRadius: 7,
							background: T.ok,
							color: '#fff',
							fontSize: 9,
							lineHeight: '14px',
							fontWeight: 600,
							textAlign: 'center',
							boxSizing: 'border-box',
						},
					}, String(running))
					: null,
			])
		}

		/**
		 * The latest rows the panel rendered, kept outside React so the sidebar
		 * icon can show the running count without a second host subscription.
		 * @type {{ items: object[], running: number, version: number, listeners: Set<Function> }}
		 */
		const federationStore = { items: [], running: 0, version: 0, listeners: new Set() }

		/**
		 * Subscribe to federation-cache changes.
		 * @param {() => void} listener - the subscriber.
		 * @returns {() => void} the unsubscribe.
		 */
		function subscribeFederation(listener) {
			federationStore.listeners.add(listener)
			return () => { federationStore.listeners.delete(listener) }
		}

		/**
		 * @returns {number} how many listed sessions are running.
		 */
		function getFederationRunningCount() {
			return federationStore.running
		}

		/**
		 * Replace the shared cache and notify every subscriber.
		 * @param {object[]} items - the rows the panel is showing.
		 * @returns {void}
		 */
		function publishFederation(items) {
			const list = Array.isArray(items) ? items : []
			const running = list.filter(row => row.running === true).length
			if (running === federationStore.running && list.length === federationStore.items.length) return
			federationStore.items = list
			federationStore.running = running
			federationStore.version += 1
			for (const listener of [...federationStore.listeners]) listener()
		}

		/**
		 * Like {@link ago}, but blank for a missing or zero stamp — the row
		 * metadata line must not print "never" into the middle of a separator-joined
		 * string.
		 * @param {number | undefined} value - the stamp.
		 * @returns {string} a short human string, or ''.
		 */
		function shortAgo(value) {
			if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return ''
			if (Date.now() - value < 60000) return t('ago.now')
			return ago(value)
		}

		/** A directory path shortened for a one-line row. */
		function shortenCwd(cwd) {
			if (typeof cwd !== 'string' || cwd === '') return ''
			const parts = cwd.replace(/[/\\]+$/, '').split(/[/\\]/)
			if (parts.length <= 3) return cwd
			return `…/${parts.slice(-2).join('/')}`
		}

		/**
		 * The remote-session panel body (the keyed `main` occupant).
		 *
		 * Read-only by construction: it renders what the host already fetched and
		 * offers exactly three actions, all of which are reads or local
		 * bookkeeping — switch peer, refresh, open the remote GUI in a new window.
		 * @returns {object} the element tree.
		 */
		function FederationPanel() {
			const [state, setState] = React.useState({
				loading: true,
				peers: [],
				snapshots: [],
				poll: {},
				peerId: undefined,
				snapshot: undefined,
				status: 'idle',
				error: undefined,
				message: '',
			})
			const [selected, setSelected] = React.useState(undefined)
			const [search, setSearch] = React.useState('')
			const [editing, setEditing] = React.useState(undefined)
			// Which saved machine the editor form is bound to. Held separately from
			// `active` (the panel's data source) so managing a second machine does
			// not require switching the whole panel over to it first.
			const [editingTarget, setEditingTarget] = React.useState(undefined)

			/**
			 * Fetch the current peer's sessions. `force` asks the host for a fresh
			 * read; otherwise the host answers from its own snapshot, so the panel
			 * may call this at any cadence without multiplying remote traffic.
			 * @param {{ force?: boolean, peerId?: string, visible?: boolean }} [options] - request options.
			 * @returns {Promise<void>}
			 */
			/** Sequence number of the newest `/sessions` request, so a slow older one cannot win. */
			const loadGeneration = React.useRef(0)

			const load = React.useCallback(async (options = {}) => {
				// These are forced SSH reads that can take seconds, so two of them can
				// finish out of order. Only the newest request may write state, or
				// clicking machine A then B could leave A's slower answer on screen.
				const generation = ++loadGeneration.current
				setState(current => ({ ...current, loading: true }))
				try {
					const body = await fed('/sessions', {
						...(options.peerId === undefined ? {} : { peerId: options.peerId }),
						...(options.force === true ? { force: true } : {}),
						// Visibility drives the host's single poller: the panel is the
						// only thing that knows it is on screen.
						visible: options.visible !== false,
					})
					if (generation !== loadGeneration.current) return
					const items = body.snapshot?.items ?? []
					publishFederation(items)
					setState({
						loading: false,
						peers: body.peers ?? [],
						snapshots: body.snapshots ?? [],
						poll: body.poll ?? {},
						peerId: body.peerId,
						snapshot: body.snapshot,
						status: body.status ?? 'idle',
						error: body.error,
						message: '',
					})
					if (body.peerId !== undefined && selected === undefined) setSelected(body.peerId)
				} catch (error) {
					if (generation !== loadGeneration.current) return
					setState(current => ({ ...current, loading: false, error: { code: 'local', message: String(error?.message ?? error) } }))
				}
			}, [selected])

			// Mount: start polling, and make sure leaving the page stops the host's
			// poller too. Closing the tab or reloading never unmounts a React tree,
			// so an unmount-only cleanup left the host reading that remote every
			// interval for the rest of its life, with no viewer to show it to.
			React.useEffect(() => {
				void load()
				const stop = () => { void fed('/poll', { visible: false }).catch(() => {}) }
				window.addEventListener('pagehide', stop)
				return () => {
					window.removeEventListener('pagehide', stop)
					stop()
				}
			}, [])

			// The cadence itself. The host owns the timing (it dedupes concurrent
			// reads), so the panel only has to keep asking; without this the list,
			// the running count and the icon badge all froze at mount time.
			const pollIntervalMs = typeof state.poll?.intervalMs === 'number' ? state.poll.intervalMs : 15000
			React.useEffect(() => {
				const id = window.setInterval(() => { void load() }, pollIntervalMs)
				return () => { window.clearInterval(id) }
			}, [load, pollIntervalMs])

			const peers = state.peers
			const active = peers.find(peer => peer.id === state.peerId) ?? peers.find(peer => peer.id === selected)
			const snapshot = state.snapshot
			const rows = snapshot?.items ?? []
			const running = rows.filter(row => row.running === true).length

			/**
			 * Switch the peer this panel (and the host poller) follows.
			 * @param {string} peerId - the peer to follow.
			 * @returns {void}
			 */
			const selectPeer = (peerId) => {
				setSelected(peerId)
				void load({ peerId, force: true })
			}

			/**
			 * Open one peer's remote GUI in a NEW window.
			 *
			 * The host builds the URL, so the paired-device credential that makes
			 * the cookieless landing work never reaches this code. A peer with
			 * neither `jumpUrl` nor `openOrigin` is reachable only through the
			 * tunnel and simply cannot be opened from here — the panel says so
			 * instead of opening a wrong local address.
			 * @param {object} peer - the peer row.
			 * @param {string} [sessionId] - the row that was clicked (for context).
			 * @returns {void}
			 */
			const open = (peer, sessionId) => {
				if (peer === undefined) return
				const target = peer.jumpUrl ?? (peer.openOrigin === undefined ? undefined : `${peer.openOrigin}/`)
				if (target === undefined) {
					// Returning silently here — which is what this used to do, despite
					// a comment claiming otherwise — left a click with no effect and no
					// explanation, so the panel looked like it simply had no jump at
					// all. Say why, and say what to fill in.
					const host = peer.channel === 'ssh' ? peer.ssh.host : String(peer.origin ?? '').replace(/^https?:\/\//u, '')
					const port = peer.channel === 'ssh' ? peer.ssh.remotePort : ''
					setState(current => ({ ...current, message: t('fed.noBrowserTarget', { host, port }) }))
					return
				}
				if (typeof peer.id === 'string') {
					void fed('/peers', { action: 'touch', id: peer.id }).catch(() => {})
				}
				if (sessionId !== undefined) setState(current => ({ ...current, message: t('fed.noSessionUrl') }))
				window.open(target, '_blank', 'noopener,noreferrer')
			}

			const filtered = search.trim() === ''
				? rows
				: rows.filter(row => {
					const needle = search.trim().toLowerCase()
					return row.title.toLowerCase().includes(needle) ||
						(typeof row.cwd === 'string' && row.cwd.toLowerCase().includes(needle))
				})

			const groups = []
			for (const row of filtered) {
				const key = typeof row.cwd === 'string' && row.cwd !== '' ? row.cwd : ''
				let group = groups.find(candidate => candidate.key === key)
				if (group === undefined) {
					const parts = key === '' ? [] : key.replace(/[/\\]+$/, '').split(/[/\\]/)
					group = { key: key === '' ? '__ungrouped__' : key, label: key === '' ? t('fed.ungrouped') : (parts[parts.length - 1] || key), sessions: [] }
					groups.push(group)
				}
				group.sessions.push(row)
			}

			const rowStyle = {
				display: 'flex',
				alignItems: 'center',
				gap: 8,
				padding: '5px 6px',
				borderRadius: 6,
			}

			return h('div', {
				'data-dsh-plugin': 'dsh-remote-switch',
				style: {
					display: 'flex',
					flexDirection: 'column',
					height: '100%',
					minHeight: 0,
					color: T.text,
					fontSize: 13,
				},
			}, [
				// ── header: peer picker + refresh ───────────────────────────────
				h('div', {
					key: 'head',
					style: {
						display: 'flex',
						alignItems: 'center',
						gap: 8,
						padding: '10px 14px',
						borderBottom: `1px solid ${T.border}`,
						flex: 'none',
					},
				}, [
					h('div', { key: 't', style: { fontWeight: 600, flex: 'none' } }, t('fed.rowTitle')),
					// No dropdown: the machine list below IS the picker, so a second
					// machine selector in the header was two controls for one job.
					peers.length === 0
						? h('span', { key: 'none', style: { color: T.muted, fontSize: 12 } }, t('fed.noMachines'))
						: null,
					h('span', { key: 'sp', style: { flex: 1 } }),
					snapshot !== undefined
						? h('span', { key: 'run', style: { fontSize: 12, color: running > 0 ? T.ok : T.muted } },
							running > 0 ? t('fed.runningCount', { n: running }) : t('fed.noneRunning'))
						: null,
					h('button', {
						key: 'r',
						type: 'button',
						disabled: state.peerId === undefined || state.loading,
						onClick: () => { void load({ force: true }) },
						style: { ...button, opacity: state.peerId === undefined || state.loading ? 0.5 : 1 },
					}, state.loading ? t('fed.refreshing') : t('fed.refresh')),
				]),

				// ── the standing caveat: this panel is a window, not a control ──
				h('div', {
					key: 'caveat',
					style: { padding: '6px 14px', fontSize: 11, color: T.muted, borderBottom: `1px solid ${T.border}`, flex: 'none', lineHeight: 1.5 },
				}, t('fed.readonly')),

				// ── search ──────────────────────────────────────────────────────
				peers.length > 0
					? h('div', { key: 'search', style: { padding: '8px 14px 0', flex: 'none' } }, [
						h('input', {
							key: 'i',
							value: search,
							placeholder: t('fed.search'),
							onChange: event => { setSearch(event.target.value) },
							style: input,
						}),
					])
					: null,

				// ── the machine list ─────────────────────────────────────────────
				// Always visible, and every row opens its own remote directly.
				// Requiring the user to switch the whole panel to a machine before
				// jumping to it defeated the point of having a list at all.
				h('div', { key: 'machines', style: { flex: 'none', borderTop: `1px solid ${T.border}`, padding: '8px 14px 10px' } }, [
					h('div', { key: 'head', style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 } }, [
						h('span', { key: 't', style: { fontSize: 11, fontWeight: 600, color: T.muted } }, t('fed.machinesTitle')),
						h('span', { key: 'n', style: { fontSize: 11, color: T.muted } }, t('fed.savedCount', { n: peers.length })),
						h('span', { key: 'sp', style: { flex: 1 } }),
						// Adding has to be reachable from HERE, not only from the empty
						// state: otherwise a saved list could be edited and deleted but
						// never extended by hand.
						h('button', {
							key: 'a',
							type: 'button',
							onClick: () => {
								setEditingTarget(undefined)
								setEditing({ channel: 'ssh', blank: true })
							},
							style: { ...button, fontWeight: 600 },
						}, t('fed.addMachine')),
					]),
					h('div', { key: 'hint', style: { fontSize: 10, color: T.muted, marginBottom: 5, lineHeight: 1.5 } }, t('fed.pickEdit')),
					peers.length === 0
						? null
						: h('div', { key: 'list', style: { display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 208, overflowY: 'auto' } },
							peers.map(peer => {
								const isActive = peer.id === state.peerId
								const canOpen = peer.jumpUrl !== undefined || peer.openOrigin !== undefined
								const reach = peer.channel === 'ssh'
									? `${peer.ssh.user}@${peer.ssh.host}:${String(peer.ssh.port)} → ${String(peer.ssh.remotePort)}`
									: peer.origin.replace(/^https?:\/\//u, '')
								return h('div', {
									key: peer.id,
									style: {
										display: 'flex',
										alignItems: 'center',
										// The name has a floor (see below); once the buttons and
										// the name together no longer fit, wrapping keeps all of
										// them usable instead of overflowing the panel.
										flexWrap: 'wrap',
										gap: 6,
										padding: '4px 6px 4px 8px',
										borderRadius: T.radius,
										border: `1px solid ${T.border}`,
										borderLeft: `3px solid ${isActive ? T.ok : T.border}`,
										background: isActive ? T.hover : 'transparent',
									},
								}, [
									h('button', {
										key: 'p',
										type: 'button',
										title: t('fed.switchTo'),
										// Picking a row must also LEAVE "new" mode. Setting only
										// the target left `blank` set, so after clicking "add a
										// machine" the form stayed empty whichever row was picked.
										onClick: () => { selectPeer(peer.id) },
										style: {
											flex: '1 1 auto',
											// A floor, not zero: `minWidth: 0` lets the row's
											// buttons squeeze the machine name down to nothing
											// in a narrow sidebar, which is the exact bug this
											// list had before (the name vanished, only buttons
											// remained). Past the floor the row wraps instead.
											minWidth: 96,
											display: 'flex',
											flexDirection: 'column',
											alignItems: 'flex-start',
											gap: 1,
											font: 'inherit',
											textAlign: 'left',
											padding: 0,
											border: 'none',
											background: 'transparent',
											color: T.text,
											cursor: 'pointer',
										},
									}, [
										h('span', {
											key: 'l',
											style: {
												fontSize: 12,
												fontWeight: isActive ? 600 : 400,
												maxWidth: '100%',
												overflow: 'hidden',
												textOverflow: 'ellipsis',
												whiteSpace: 'nowrap',
											},
										}, peer.label),
										h('span', {
											key: 'r',
											style: {
												fontSize: 10,
												color: T.muted,
												maxWidth: '100%',
												overflow: 'hidden',
												textOverflow: 'ellipsis',
												whiteSpace: 'nowrap',
											},
										}, reach),
									]),
									isActive
										? h('span', { key: 'cur', style: { flex: 'none', fontSize: 10, fontWeight: 600, color: T.ok } }, t('fed.current'))
										: null,
									h('button', {
										key: 'o',
										type: 'button',
										disabled: !canOpen,
										title: canOpen ? t('fed.openRemoteHint') : t('fed.openRemoteHintNoTarget'),
										onClick: () => { open(peer) },
										style: canOpen ? button : { ...button, opacity: 0.45, cursor: 'default' },
									}, t('fed.openRemote')),
									h('button', {
										key: 'g',
										type: 'button',
										title: t('fed.editThis'),
										onClick: () => {
											setEditingTarget(peer.id)
											setEditing({ channel: peer.channel })
										},
										style: button,
									}, t('fed.edit')),
								])
							})),
					editing !== undefined
						// A drawer, not an inline block. Rendered inline, the editor
						// pushed the session list off screen, squeezed a 560px form into
						// the middle of a wide panel, and scrolled away with the list —
						// the layout problem that was reported. `position: fixed` also
						// escapes the body's own `overflowY: auto`, which would otherwise
						// clip an absolutely-positioned child.
						? h('div', {
							key: 'overlay',
							style: {
								position: 'fixed',
								inset: 0,
								zIndex: 60,
								display: 'flex',
								justifyContent: 'flex-end',
								background: 'var(--dsw-alias-bg-mask-1, rgba(0,0,0,.35))',
							},
							// Clicking the backdrop closes, the usual way out.
							onClick: () => { setEditing(undefined) },
						}, [
							h('div', {
								key: 'drawer',
								style: {
									width: 'min(560px, 100vw)',
									height: '100%',
									overflowY: 'auto',
									display: 'flex',
									flexDirection: 'column',
									gap: 10,
									padding: '12px 16px 20px',
									background: 'var(--dsw-alias-bg-layer-2, #fff)',
									borderLeft: `1px solid ${T.border}`,
									boxShadow: '-10px 0 28px rgba(0,0,0,.18)',
								},
								// Clicks inside must not reach the backdrop.
								onClick: event => { event?.stopPropagation?.() },
							}, [
								h('div', { key: 'bar', style: { display: 'flex', alignItems: 'center', gap: 8 } }, [
									h('div', { key: 't', style: { fontWeight: 600, flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
										editing.blank === true
											? t('editor.titleNew')
											: t('editor.titleEdit', { label: (peers.find(candidate => candidate.id === editingTarget) ?? active)?.label ?? '' })),
									h('button', {
										key: 'x',
										type: 'button',
										onClick: () => { setEditing(undefined) },
										style: button,
									}, t('editor.close')),
								]),
								h(PeerEditor, {
									key: 'editor',
									// `editing.blank` means "add a new one"; otherwise the target
									// is the picked row, falling back to the active peer so the
									// old single-machine behaviour is unchanged. Re-seeding the
									// form when the target changes is PeerEditor's own job.
									peer: editing.blank === true
										? undefined
										: (peers.find(candidate => candidate.id === editingTarget) ?? active),
									draft: editing,
									onDone: (message) => {
										setEditing(undefined)
										setState(current => ({ ...current, message }))
										void load({ force: true })
									},
									// The lifecycle buttons stay in the drawer (unlike save), so
									// they need their own way to make the panel re-read: a
									// restart has just replaced this peer's token, and the panel
									// is still holding the peer list — and therefore the jump
									// URL — from before it.
									onRefresh: () => { void load({ force: true }) },
								}),
							]),
						])
						: null,
				]),

				// ── body ────────────────────────────────────────────────────────
				h('div', { key: 'body', style: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '10px 14px 16px' } }, [
					peers.length === 0
						? h(EmptyState, { key: 'empty', onAdd: () => { setEditing({ channel: 'ssh', blank: true }) } })
						: null,

					state.error !== undefined && state.snapshot === undefined
						? h(ErrorNotice, { key: 'err', error: state.error, peer: active })
						: null,

					// A stale snapshot stays on screen while the remote is down: the
					// rows are labelled with their age, so "what was there" is still
					// readable and never mistaken for live data.
					state.error !== undefined && state.snapshot !== undefined && snapshot.source !== 'static'
						? h('div', {
							key: 'stale',
							style: { margin: '0 0 8px', padding: '6px 8px', borderRadius: 6, background: 'rgba(209,67,67,.10)', color: T.bad, fontSize: 11, lineHeight: 1.5 },
						}, t('fed.stale', { code: state.error.code, message: state.error.message, ago: shortAgo(snapshot.fetchedAt) }))
						: null,

					// A static snapshot is a different kind of thing from a stale live
					// one, and must not be mistaken for it: these rows were read off
					// the remote's disk because its instance is down, so what the
					// panel can and cannot know is different. It gets its own banner
					// and its own heading rather than reusing the stale wording.
					snapshot?.source === 'static'
						? h('div', {
							key: 'static',
							style: {
								margin: '0 0 8px',
								padding: '8px 10px',
								borderRadius: 6,
								border: `1px dashed ${T.border}`,
								fontSize: 11,
								lineHeight: 1.6,
								color: T.muted,
							},
						}, [
							h('div', { key: 'h', style: { fontWeight: 600, color: T.text, marginBottom: 4 } }, t('fed.staticTitle')),
							h('div', { key: 'b' }, t('fed.staticBody', { ago: shortAgo(snapshot.fetchedAt) })),
						])
						: null,

					(snapshot?.warnings ?? []).map((warning, index) =>
						h('div', { key: `w${String(index)}`, style: { fontSize: 11, color: T.muted, marginBottom: 6 } }, warning)),
					groups.map(group => h('div', { key: group.key, style: { marginBottom: 10 } }, [
						h('div', {
							key: 'h',
							style: { display: 'flex', alignItems: 'baseline', gap: 6, padding: '4px 2px', fontSize: 11, color: T.muted },
						}, [
							h('span', { key: 'n', style: { fontWeight: 600, color: T.text } }, group.label),
							h('span', { key: 'c', title: group.key === '__ungrouped__' ? '' : group.key, style: { flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } },
								group.key === '__ungrouped__' ? t('fed.ungroupedHint') : shortenCwd(group.key)),
							h('span', { key: 'k', style: { flex: 'none' } }, t('fed.count', { n: group.sessions.length })),
						]),
						group.sessions.map(row => h('div', {
							key: row.sessionId,
							onClick: () => { open(active, row.sessionId) },
							title: `${row.title}\n${row.cwd ?? ''}\n${t('fed.updatedAt', { time: new Date(row.updatedAt).toLocaleString() })}`,
							style: { ...rowStyle, cursor: active === undefined ? 'default' : 'pointer' },
							onMouseEnter: event => { event.currentTarget.style.background = T.hover },
							onMouseLeave: event => { event.currentTarget.style.background = 'transparent' },
						}, [
							h(Dot, { key: 'd', state: row.running ? 'ok' : 'idle', title: row.running ? t('fed.running') : t('fed.idle') }),
							h('div', { key: 'm', style: { flex: 1, minWidth: 0 } }, [
								h('div', {
									key: 't',
									style: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontWeight: row.running ? 600 : 400 },
								}, row.title),
								h('div', { key: 's', style: { fontSize: 11, color: T.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } },
									[shortenCwd(row.cwd), shortAgo(row.updatedAt), row.sessionId.slice(0, 8)].filter(part => part !== '').join(' · ')),
							]),
							row.running
								? h('span', { key: 'r', style: { fontSize: 11, color: T.ok, flex: 'none' } }, t('fed.running'))
								: null,
						])),
					])),

					snapshot !== undefined && filtered.length === 0 && peers.length > 0
						? h('div', { key: 'zero', style: { color: T.muted, fontSize: 12, padding: '8px 2px' } },
							rows.length === 0 ? t('fed.emptyAll') : t('fed.noMatch'))
						: null,

					snapshot?.truncated === true
						? h('div', { key: 'more', style: { color: T.muted, fontSize: 11, padding: '8px 2px' } },
							t('fed.truncated', { total: snapshot.total, shown: rows.length }))
						: null,
				]),

				state.message !== '' ? h('div', {
					key: 'msg',
					style: { padding: '6px 14px', fontSize: 11, color: T.muted, borderTop: `1px solid ${T.border}`, flex: 'none' },
				}, state.message) : null,

			])
		}

		/**
		 * The first-run state: what this panel is, and the one action that makes
		 * it do anything.
		 * @param {{ onAdd: () => void }} props - the add action.
		 * @returns {object} the element tree.
		 */
		function EmptyState(props) {
			return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 560, padding: '18px 2px' } }, [
				h('div', { key: 't', style: { fontSize: 14, fontWeight: 600 } }, t('fed.emptyTitle')),
				h('div', { key: 'b', style: { fontSize: 12, color: T.muted, lineHeight: 1.7 } },
					t('fed.emptyBody')),
				h('div', { key: 'n', style: { fontSize: 12, color: T.muted, lineHeight: 1.7 } },
					t('fed.emptyHow')),
				h('div', { key: 'a' }, [
					h('button', { key: 'b', type: 'button', onClick: props.onAdd, style: { ...button, fontWeight: 600 } }, t('fed.addMachine')),
				]),
			])
		}

		/**
		 * A failure rendered in the §5.4 vocabulary: the code, the correction, and
		 * the one action that applies to it. Never a silent retry.
		 * @param {{ error: { code: string, message: string }, peer?: object }} props - the failure.
		 * @returns {object} the element tree.
		 */
		function ErrorNotice(props) {
			const code = props.error?.code ?? 'error'
			// Keys rather than copy: these are looked up per render so a language
			// switch re-labels an already-visible failure.
			const guidanceKeys = {
				'ssh-auth': 'err.ssh-auth',
				'ssh-host-key': 'err.ssh-host-key',
				'ssh-timeout': 'err.ssh-timeout',
				'ssh-refused': 'err.ssh-refused',
				'ssh-remote-not-listening': 'err.ssh-remote-not-listening',
				'ssh-dns': 'err.ssh-dns',
				'ssh-key-unreadable': 'err.ssh-key-unreadable',
				'http-timeout': 'err.http-timeout',
				'unauthorized': 'err.unauthorized',
				'forbidden': 'err.forbidden',
				'not-found': 'err.not-found',
				'no-credential': 'err.no-credential',
				'no-device-credential': 'err.no-device-credential',
				'token-rejected': 'err.token-rejected',
				'provision-dsh-not-found': 'err.provision-dsh-not-found',
				'gateway/internal': 'err.gateway/internal',
			}
			const guidanceKey = guidanceKeys[code]
			const guidance = guidanceKey === undefined ? undefined : t(guidanceKey)
			return h('div', {
				style: {
					display: 'flex',
					flexDirection: 'column',
					gap: 6,
					padding: '10px 12px',
					borderRadius: T.radius,
					border: `1px solid ${T.border}`,
					background: 'rgba(209,67,67,.06)',
					maxWidth: 560,
				},
			}, [
				h('div', { key: 'c', style: { fontSize: 12, fontWeight: 600, color: T.bad } }, code),
				h('div', { key: 'm', style: { fontSize: 12, lineHeight: 1.6 } }, props.error?.message ?? ''),
				guidance === undefined ? null : h('div', { key: 'g', style: { fontSize: 12, color: T.muted, lineHeight: 1.6 } }, guidance),
				props.peer !== undefined
					? h('div', { key: 'p', style: { fontSize: 11, color: T.muted } },
						t('fed.machineLine', {
							name: props.peer.label,
							where: props.peer.channel === 'ssh' ? `${props.peer.ssh.user}@${props.peer.ssh.host}:${String(props.peer.ssh.port)}` : props.peer.origin,
						}))
					: null,
			])
		}

		/**
		 * Add or edit one machine.
		 *
		 * The SSH form is deliberately two independent halves: how to *reach* the
		 * machine, and where a *browser* would open its GUI. Conflating them is the
		 * mistake that produces a panel listing sessions correctly while its "open"
		 * button lands on a local port.
		 * @param {{ peer?: object, draft: object, onDone: (message: string) => void, onRefresh?: () => void }} props - editor props.
		 * @returns {object} the element tree.
		 */
		function PeerEditor(props) {
			const editing = props.peer

			/**
			 * The form fields for one peer.
			 *
			 * Extracted so the initial mount and the retarget effect below seed the
			 * SAME shape — duplicating it is how the two drift apart.
			 * @param {object | undefined} peer - the peer being edited, if any.
			 * @returns {object} the initial field values.
			 */
			const seedForm = (peer) => ({
				label: peer?.label ?? '',
				origin: peer?.channel === 'http' ? peer.origin : '',
				webOrigin: peer?.channel === 'ssh' ? (peer.webOrigin ?? '') : '',
				host: peer?.ssh?.host ?? '',
				user: peer?.ssh?.user ?? '',
				port: String(peer?.ssh?.port ?? 22),
				remotePort: String(peer?.ssh?.remotePort ?? 3080),
				privateKeyPath: peer?.ssh?.privateKeyPath ?? '',
				password: '',
				authKind: peer?.auth?.kind ?? 'token',
				token: '',
			})

			const [channel, setChannel] = React.useState(editing?.channel ?? props.draft.channel ?? 'ssh')
			const [form, setForm] = React.useState(() => seedForm(editing))
			const [busy, setBusy] = React.useState(false)
			const [message, setMessage] = React.useState('')
			// Seeded from the stored peer: this value is PERSISTED on save, because
			// the static fallback needs it to find `sessions/` long after this form
			// is closed. Keeping it as transient local state would mean the fallback
			// could only ever work in the session where it was typed.
			const [remoteHome, setRemoteHome] = React.useState(editing?.remoteHome ?? '')
			const [remoteDsh, setRemoteDsh] = React.useState('')

			// Re-seed when the editor is pointed at a DIFFERENT machine.
			//
			// `useState(initial)` only runs on mount, so switching the picker from
			// one saved machine to another left the previous machine's host/port in
			// these inputs — and "save" would then have written them onto the newly
			// picked row. An explicit effect (rather than relying on a `key` remount)
			// keeps this correct for any renderer and makes it testable.
			const targetId = editing?.id ?? 'new'
			const seededFor = React.useRef(targetId)
			React.useEffect(() => {
				if (seededFor.current === targetId) return
				seededFor.current = targetId
				setChannel(editing?.channel ?? props.draft.channel ?? 'ssh')
				setForm(seedForm(editing))
				setRemoteHome(editing?.remoteHome ?? '')
				setRemoteDsh('')
				setMessage('')
			}, [targetId])

			const set = (key, value) => { setForm(current => ({ ...current, [key]: value })) }

			/**
			 * Send the form to the host.
			 * @param {object} body - the save request.
			 * @returns {Promise<void>}
			 */
			const send = async (body) => {
				setBusy(true)
				setMessage('')
				try {
					await fed('/peers', body)
					// Three outcomes, three messages: `forget-credential` used to fall
					// into the "removed" branch and told the user the machine was gone
					// while it was still in the list.
					const done = body.action === 'save'
						? t('editor.saved')
						: body.action === 'forget-credential' ? t('editor.forgotten') : t('editor.removed')
					props.onDone(done)
				} catch (error) {
					setMessage(String(error?.message ?? error))
				} finally {
					setBusy(false)
				}
			}

			/**
			 * Drive the remote instance lifecycle for the peer being edited.
			 * @param {'start'|'stop'|'status'|'read-token'} action - what to do.
			 * @param {{ force?: boolean }} [options] - `force` restarts an instance that is already running.
			 * @returns {Promise<void>}
			 */
			const provision = async (action, options = {}) => {				if (editing === undefined) return
				setBusy(true)
				setMessage('')
				try {
					const result = await fed('/provision', {
						id: editing.id,
						action,
						...(remoteHome.trim() === '' ? {} : { remoteHome: remoteHome.trim() }),
						...(remoteDsh.trim() === '' ? {} : { remoteDsh: remoteDsh.trim() }),
						...(options.force === true ? { force: true } : {}),
					})
					const outcome = result.provision ?? {}
					if (outcome.ok === false) {
						// The host attaches the remote log tail to a failed start, and
						// that tail is where the actual cause is (a missing package, a
						// port clash, a wrong DSH_HOME). Showing only the code left the
						// user with "it didn't work" and no way to find out why.
						const log = typeof outcome.details?.log === 'string' ? outcome.details.log.trim() : ''
						setMessage(
							t('editor.testFail', { code: outcome.code ?? '', detail: outcome.detail ?? '' }) +
							(log === '' ? '' : `\n${t('editor.provisionLog')}\n${log.slice(-1200)}`),
						)
						return
					}
					if (action === 'status') {
						setMessage(outcome.unknown === true
							// "Cannot tell" is a third answer. Reporting "not running" when
							// the probe itself failed is how the panel used to lie about a
							// Windows machine that was in fact serving.
							? t('editor.provisionUnknown', { evidence: outcome.evidence ?? '' })
							: outcome.listening ? t('editor.provisionRunning', { evidence: outcome.evidence ?? '' }) : t('editor.provisionStopped'))
						return
					}
					if (action === 'start') {
						setMessage(outcome.started
							? t('editor.provisionStarted', { port: outcome.port })
							// "It was already running, nothing restarted" is true but not an
							// answer: the reason anyone presses start on a running instance is
							// that their token stopped working, and the remote prints a new
							// token every boot. Say what to press next.
							: `${t('editor.provisionAlready')}\n${t('editor.provisionAlreadyHint')}`)
						return
					}
					if (action === 'stop') {
						setMessage(outcome.stopped ? t('editor.provisionStoppedOk') : t('editor.provisionStopNone'))
						return
					}
					setMessage(outcome.found ? t('editor.provisionTokenOk') : t('editor.provisionTokenNone'))
				} catch (error) {
					setMessage(String(error?.message ?? error))
				} finally {
					setBusy(false)
					// Every action here can change this peer's jump URL — a restart
					// captured a NEW token, and the harness rejects a URL whose token
					// does not match the running instance. The panel is still holding
					// the peer list it loaded BEFORE the action, so "open remote" would
					// hand the browser the previous token and land on the 401 page.
					// Re-read, so the next click is already correct.
					props.onRefresh?.()
				}
			}

			const save = () => {
				const body = {
					action: 'save',
					...(editing === undefined ? {} : { id: editing.id }),
					channel,
					label: form.label,
					auth: { kind: form.authKind, ...(form.authKind === 'token' && form.token.trim() !== '' ? { token: form.token.trim() } : {}) },
				}
				if (channel === 'ssh') {
					const port = Number(form.port)
					const remotePort = Number(form.remotePort)
					body.ssh = {
						host: form.host.trim(),
						user: form.user.trim(),
						...(Number.isInteger(port) && port > 0 ? { port } : {}),
						...(Number.isInteger(remotePort) && remotePort > 0 ? { remotePort } : {}),
						...(form.privateKeyPath.trim() !== '' ? { privateKeyPath: form.privateKeyPath.trim() } : {}),
						...(form.password !== '' ? { password: form.password } : {}),
					}
					body.webOrigin = form.webOrigin
					// Saved, not just used for this request: the static fallback reads
					// `sessions/` under it whenever the remote instance is down.
					body.remoteHome = remoteHome.trim()
				} else {
					body.origin = form.origin
				}
				void send(body)
			}

			const field = (key, label, placeholder, type) => h('label', {
				key,
				style: { display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11, color: T.muted },
			}, [
				label,
				h('input', {
					key: 'i',
					type: type ?? 'text',
					value: form[key],
					placeholder,
					onChange: event => { set(key, event.target.value) },
					style: input,
				}),
			])

			return h('div', { style: { marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 560 } }, [
				h('div', { key: 'ch', style: { display: 'flex', gap: 12, fontSize: 12 } },
					[['ssh', t('editor.channelSsh')], ['http', t('editor.channelHttp')]].map(([value, label]) =>
						h('label', { key: value, style: { display: 'inline-flex', alignItems: 'center', gap: 4 } }, [
							h('input', {
								key: 'r',
								type: 'radio',
								name: 'federation-channel',
								checked: channel === value,
								onChange: () => { setChannel(value) },
							}),
							label,
						]))),

				field('label', t('editor.label'), t('editor.labelPlaceholder')),

				channel === 'ssh'
					? h('div', { key: 'ssh', style: { display: 'flex', flexDirection: 'column', gap: 8 } }, [
						h('div', { key: 'a', style: { display: 'flex', gap: 8 } }, [
							h('div', { key: 'h', style: { flex: 2 } }, [field('host', t('editor.host'), t('editor.hostPlaceholder'))]),
							h('div', { key: 'u', style: { flex: 1 } }, [field('user', t('editor.user'), 'liuyx')]),
							h('div', { key: 'p', style: { flex: '0 0 90px' } }, [field('port', t('editor.port'), '22')]),
						]),
						h('div', { key: 'b', style: { display: 'flex', gap: 8 } }, [
							h('div', { key: 'k', style: { flex: 2 } }, [field('privateKeyPath', t('editor.keyPath'), 'C:\\Users\\me\\.ssh\\id_ed25519')]),
							h('div', { key: 'r', style: { flex: '0 0 130px' } }, [field('remotePort', t('editor.remotePort'), '3080')]),
						]),
						// The field is ALWAYS empty, because the host never sends a stored
						// secret back (see `redactPeer` — only `hasPassword` crosses the
						// wire). Without saying so, an empty box is indistinguishable
						// from "nothing was saved", which is exactly how this read as
						// "my password disappeared". The label and placeholder therefore
						// report whether something IS stored.
						field(
							'password',
							editing?.ssh?.hasPassword === true ? t('editor.passwordStored') : t('editor.password'),
							editing?.ssh?.hasPassword === true ? t('editor.secretStoredHint') : t('editor.passwordNew'),
							'password',
						),
						field('webOrigin', t('editor.webOrigin'), 'http://192.168.1.23:3080'),
						h('div', { key: 'note', style: { fontSize: 11, color: T.muted, lineHeight: 1.6 } },
							t('editor.webOriginNote')),
					])
					: h('div', { key: 'http', style: { display: 'flex', flexDirection: 'column', gap: 8 } }, [
						field('origin', t('editor.origin'), 'http://192.168.1.23:3080'),
					]),

				h('div', { key: 'auth', style: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: T.muted } }, [
					t('editor.auth'),
					h('select', {
						key: 's',
						value: form.authKind,
						onChange: event => { set('authKind', event.target.value) },
						style: input,
					}, [
						h('option', { key: 't', value: 'token' }, t('editor.authToken')),
						h('option', { key: 'd', value: 'device' }, t('editor.authDevice')),
						h('option', { key: 'n', value: 'none' }, t('editor.authNone')),
					]),
					// Same reasoning as the SSH password above: a stored token is never
					// echoed back, so the empty box must say that it is already saved.
					form.authKind === 'token'
						? field(
							'token',
							editing?.auth?.hasToken === true ? t('editor.tokenStored') : t('editor.token'),
							editing?.auth?.hasToken === true ? t('editor.secretStoredHint') : t('editor.tokenPlaceholder'),
						)
						: null,
					form.authKind === 'device'
						? h('div', { key: 'dn', style: { lineHeight: 1.6 } },
							t('editor.deviceNote'))
						: null,
				]),

				// ── remote instance lifecycle (SSH peers only) ───────────────────
				// These drive commands on the other machine, so they are grouped and
				// labelled apart from everything else on this form — which only ever
				// reads.
				editing !== undefined && editing.channel === 'ssh'
					? h('div', { key: 'prov', style: { borderTop: `1px solid ${T.border}`, paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 6 } }, [
						h('div', { key: 'l', style: { fontSize: 11, color: T.muted } }, t('editor.remoteHome')),
						h('input', {
							key: 'h',
							value: remoteHome,
							placeholder: t('editor.remoteHomePlaceholder'),
							onChange: event => { setRemoteHome(event.target.value) },
							style: input,
						}),
						h('div', { key: 'l2', style: { fontSize: 11, color: T.muted } }, t('editor.remoteDsh')),
						h('input', {
							key: 'd',
							value: remoteDsh,
							placeholder: 'dsh',
							onChange: event => { setRemoteDsh(event.target.value) },
							style: input,
						}),
						h('div', { key: 'row', style: { display: 'flex', gap: 6, flexWrap: 'wrap' } }, [
							h('button', { key: 's', type: 'button', disabled: busy, onClick: () => { void provision('start') }, style: button }, t('editor.provision')),
							h('button', { key: 'r', type: 'button', disabled: busy, onClick: () => { void provision('start', { force: true }) }, style: button }, t('editor.provisionRestart')),
							h('button', { key: 'p', type: 'button', disabled: busy, onClick: () => { void provision('stop') }, style: button }, t('editor.provisionStop')),
							h('button', { key: 't', type: 'button', disabled: busy, onClick: () => { void provision('status') }, style: button }, t('editor.provisionStatus')),
							h('button', { key: 'k', type: 'button', disabled: busy, onClick: () => { void provision('read-token') }, style: button }, t('editor.provisionToken')),
						]),
					])
					: null,

				h('div', { key: 'actions', style: { display: 'flex', gap: 6, alignItems: 'center' } }, [
					h('button', { key: 's', type: 'button', disabled: busy, onClick: save, style: { ...button, fontWeight: 600, opacity: busy ? 0.5 : 1 } },
						busy ? t('editor.saving') : t('editor.save')),
					editing !== undefined
						? h('button', {
							key: 't',
							type: 'button',
							disabled: busy,
							onClick: async () => {
								setBusy(true)
								try {
									const result = await fed('/test', { id: editing.id })
									const probe = result.probe ?? {}
									setMessage(probe.ok === true
										? t('editor.testOk', { ms: probe.latencyMs })
										: t('editor.testFail', { code: probe.code ?? '', detail: probe.detail ?? '' }))
								} catch (error) {
									setMessage(String(error?.message ?? error))
								} finally {
									setBusy(false)
								}
							},
							style: button,
						}, t('editor.test'))
						: null,
					editing !== undefined
						? h('button', {
							key: 'f',
							type: 'button',
							disabled: busy,
							title: t('editor.forgetHint'),
							onClick: () => { void send({ action: 'forget-credential', id: editing.id }) },
							style: button,
						}, t('editor.forget'))
						: null,
					h('span', { key: 'sp', style: { flex: 1 } }),
					editing !== undefined
						? h('button', {
							key: 'r',
							type: 'button',
							disabled: busy,
							onClick: () => {
								if (window.confirm(t('editor.removeConfirm', { label: editing.label }))) {
									void send({ action: 'remove', id: editing.id })
								}
							},
							style: { ...button, color: T.bad },
						}, t('editor.remove'))
						: null,
				]),

				message !== '' ? h('div', { key: 'm', style: { fontSize: 11, color: T.muted, lineHeight: 1.6 } }, message) : null,
			])
		}

		/**
		 * Register both browser surfaces: the instance switcher at the sidebar
		 * foot, and the remote-session panel in the global panel row.
		 * @param {import('@deepseek-ai/cordis').Context} ctx - client root context.
		 * @returns {void}
		 */
		exports.apply = function apply(ctx) {
			// Resolve the copy first: every registration below closes over `t`, and
			// a label function captured before this would answer in the wrong
			// language for the life of the registration.
			registerLocale(ctx)
			ctx.slots.inject(SEAT, () => {
				let dispose
				try {
					dispose = ctx.slots.register({ name: SEAT, id: 'instance-switcher', order: 45 }, InstanceEntry)
				} catch {
					return () => {}
				}
				return () => { dispose() }
			})
			ctx.slots.inject(PANEL_SEAT, () => {
				let dispose
				try {
					dispose = ctx.slots.register(
						// `label` resolved lazily by the sidebar (it calls a function
						// label on every render), so the row re-labels on a language
						// switch instead of freezing whatever was active at boot.
						{ name: PANEL_SEAT, id: PANEL_ID, order: PANEL_ORDER, label: () => t('fed.rowTitle') },
						FederationIcon,
					)
				} catch {
					return () => {}
				}
				return () => { dispose() }
			})
			// The main key MUST equal the panellist id: the sidebar selects a panel
			// by that id, and the layout refuses to select a key with no
			// registration. Two ids that drift apart produce a row that throws on
			// click rather than a panel that does not appear.
			ctx.slots.inject('main', () => {
				let dispose
				try {
					dispose = ctx.slots.register({ name: 'main', key: PANEL_ID }, FederationPanel)
				} catch {
					return () => {}
				}
				return () => { dispose() }
			})
		}

		return module.exports
	},
})
