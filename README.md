# dsh-remote-switch

给 DeepSeek Harness Web GUI 用的两个远端实例入口：

1. **实例切换器** —— 维护一份 DSH 实例清单，在侧栏一键在**新窗口**里打开任意一台的**官方 Web GUI**（当前页面不动，所以切换器和会话一直都在）。
2. **远端会话面板** —— 侧栏的**只读**面板，列出另一台机器上有哪些会话、哪条在跑、在哪个目录；点一条就在新窗口里打开那台实例。

独立插件，**不依赖也不修改** `@linxin666/dsh-remote-web-ui`。切换器复用的是那个插件已经提供的一条公开路径：`GET <实例>/pair-app?device=<凭据>` —— 官方外壳的**无 cookie 落地页**。

---

## 它解决什么

- 你有多台跑着 DSH 的机器（本机 + 局域网/隧道后的机器）。
- 你希望在任意一台的界面里，用一个下拉框打开另一台，而不是重新扫码、重新配对、手动改地址。
- 打开后看到的是**那台实例自己的官方界面**，不是被代理的镜像——所以不存在第二套会漂移的 UI。
- 你还希望**不切窗口**就知道另一台机器上有什么在跑——那台机器上的 agent 在那边执行，这边只负责显示。

## 它不做什么

- **不做代理、不做同屏嵌入**：切换是**开一个新窗口**（跨源 iframe 带不上对方那两枚 `HttpOnly; SameSite` cookie，嵌不进去）。当前页面保持不变。
- **不驱动远端**：它不替你在目标机上执行任何操作，只负责"把你送到那台机器的界面上"。
- **会话面板是只读的**：只调远端两个读接口（`session/list` 与 `workspace/follow` 的首帧），不下发指令、不写远端任何状态、不写本地会话库。
- 不碰 `/remote` 数据通道（配对凭据那条除外，见下文）、不碰 `inner-auth`、不碰对方插件的任何文件。

---

## 远端会话面板（只读）

侧栏的**全局面板**区会多一个 🖧 **远端会话**图标。图标上的绿色数字是**正在运行的会话条数**（面板没开也能看到）。

面板里：

- **顶部**：只有 `刷新`，以及当前有几条会话在跑。
- **机器列表**：常驻在会话列表上方，**所有机器一眼可见，不需要先切过去再看**。每行是**机器名 + 接入地址**（`user@host:port → 远端端口`），右侧三个控件：`当前`（正在看的那台）、`打开远端`（新窗口打开那台实例）、`编辑`（改这台配置）。**点机器名则把下面的会话列表切到那台机器**。
- **列表**：按工作目录分组，每条显示标题 / 目录 / 更新时间 / 是否运行中；支持本地搜索。**默认每 15 秒自动刷新一次**（间隔由本机 host 决定并在响应里广播，浏览器只负责按这个节奏问），也可以随时点 `刷新` 强制立刻重读。
- **`添加机器` / 每行的 `编辑`**：都从**右侧滑出的抽屉**打开，在里面增删机器、测试连接、清除本机缓存的凭据。**删机器也在抽屉里**（`移除这台机器`），不在列表行上——行上放四个按钮会把机器名挤到看不见。

**它会过滤掉你在对方界面上也看不到的东西**：子会话（subagent）、空白会话、已归档会话——跟对方侧栏的口径一致，所以不会出现"这边有那边没有"的困惑。

### 对方实例没在跑的时候

如果那台机器 SSH 连得上、但它的 `dsh web` 没在运行，面板**不会空着**：它会经 SFTP 直接读对方磁盘上 `$DSH_HOME/sessions/**` 里每个会话文件的**头信息**，把清单照常列出来，并在顶部明确标成**静态清单**。

因为读的是文件而不是那个进程，有几件事它**知道不了**，面板会逐条说明而不是编一个看起来合理的值：

- **哪条在跑**：一律显示为空闲（实例都没起，确实没在跑）；
- **哪条是空白会话**：分不出来（那要读事件帧）；
- **真实标题**：用目录名代替（真实标题存在事件帧里）；
- **时间**：是文件的修改时间，不是最后一次提问时间；
- **归档**：归档状态存在对方进程内存里，读不到，所以归档的会话**照常列出**——宁可多列，也不隐藏你在对方界面上明明看得到的会话。

> 这条兜底只支持 **SSH 通道**（HTTP 直连没有文件访问能力），并且需要知道对方的 `DSH_HOME`（在机器设置里填，默认 `~/.dsh`）。
>
> 另外：**凭据失效（401）或访问被拒（403）时不会走这条兜底**。那是"对方明确答复了你"，不是"对方没在跑"——这时去读磁盘只会把真正的问题藏起来。

---

**两种接法**：

| 通道 | 适用 | 凭据 |
|---|---|---|
| **SSH**（推荐） | 那台机器能 SSH 进去 | 对方启动时打印的官方 token |
| **HTTP 直连** | 对方已经和这台机器配过对 | 复用「实例」面板里已存的 device 配对凭据 |

SSH 通道**不需要对方对外开任何端口**：请求走 `direct-tcpip` 到对方**自己的 `127.0.0.1`**，对方的 web server 把它当本机访问。

> ⚠️ **SSH 通道下"跳转地址"要单独填**。`origin` 在 SSH 模式下是**对方那台机器的** `127.0.0.1:3080`——在你这里指的是你自己的机器，绝不能拿来开页面。所以设置里另有一个可选的「跳转地址」（这台浏览器能打开的对方地址，比如 `http://192.168.1.23:3080`）。**留空也能用**，只是"打开远端"不可用——面板会说明原因，而不是打开一个错地址。
>
> **「打开远端」用的凭据**（由本机 host 组装；面板拿到的永远是一个现成 URL，不是一个可读的密钥字段）：
>
> | 情况 | 打开的地址 |
> |---|---|
> | 这台机器的「实例」面板**配对过**该地址 | `…/pair-app?device=<配对凭据>` —— 无 cookie 落地页，且不会因为对方换了 token 而失效 |
> | 没配对，但这台机器存了 **token** | `…/?token=<token>` —— 就是对方启动时打印的那条登录 URL |
> | 两者都没有 | 不给按钮，只显示地址 |
>
> 所以**在一台全新的电脑上，把 token 填进去就够了**：拉起远程实例、或「从日志读回 token」之后，跳转地址会自动带上它，不必先去「实例」面板配对。（早先版本这里只认配对凭据，未配对的机器会跳到一个不带任何凭据的裸地址、只能停在登录页——那是 bug，已修。存储的 token 也一直在用，只是用在读取会话那条路径上：host 侧用它换 cookie 再调 `/api/session/list`。）

**新建 SSH peer 需要**：主机、用户名（端口默认 22，对方 `dsh web` 端口默认 3080）、私钥路径（推荐）或 SSH 密码。**私钥优先**：填了私钥路径就只用私钥，密码会被忽略。

> ⚠️ **私钥必须是没有密码短语的**。加密私钥目前不支持（代码不传 `passphrase`，会报 `Encrypted OpenSSH private key detected, but no passphrase given`）。如果你的密钥有密码短语，先用 `ssh-keygen -p -f <key>` 去掉，或改成用 SSH 密码。

> 首次连接采用 **TOFU**：记住对方主机密钥，之后变化立即拒绝（记录在 `$DSH_HOME/federation/known_hosts.json`）。

### 替对方拉起 / 关闭实例

机器**编辑抽屉**里（SSH peer）还有一组控件，用来在不登录那台机器的前提下启动或停止它的 `dsh web`：

- **拉起远程实例** —— 经 SSH 分离启动，输出写到对方的 `<DSH_HOME>/federation/web.log`。`dsh web` 的 token **只打印一次在 stdout**，所以拉起成功后本插件会从那份日志里把它读回来并直接存到 peer 上——**不需要手抄任何东西，起来即可用**。若对方本来就在跑，则不会重复启动（并会告诉你下一步该按什么，见下）。
- **重启并重新捕获 token** —— 对方已经在跑、而你手里那份 token 已经失效时的**一键修法**。它做的是"先关闭、再拉起"，因为**日志只在拉起那一刻被清空**，只有重新拉起才能把**本轮**的 token 写进日志。远端每次启动都会换 token，所以这是拿新 token 的唯一自动途径。
- **关闭远程实例** —— 先按**对方机器上记下的 pid**（`<DSH_HOME>/federation/web.pid`，由「拉起」写入），再退回到"占用该端口的进程"，所以**手工启动的实例也能从这里关掉**。
- **查看远端状态** —— 只查，不启停。
- **从日志读回 token** —— 实例在跑但你没存 token 时的补救路径。⚠️ **它读回的 token 会先被拿去验证，验证不通过就不存**：日志只有本插件拉起时才写，所以手工起的实例（或重启后手工起的）日志里躺的是**更早一轮**的 token——直接存下去等于用一个死凭据换掉另一个，还报成功。被远端拒（401）时它会明确告诉你 `token-stale` 并让你用上面那条「重启并重新捕获」；若是**连不上**导致没法验证，它会照实说是连不上，不会冒充"token 过期"。
- **查看远端日志** —— 把对方 `<DSH_HOME>/federation/web.log` 的末尾直接显示在面板里，**原样显示，token 也在里面**。这是排查"到底哪一步不对"最有用的一个视图：日志里那行 `dsh web: http://127.0.0.1:<端口>/?token=<token> (LAN: http://<地址>:<端口>/?token=<token>)` 会告诉你**这台实例实际起在哪个端口/地址**，拿它和你配置的「跳转地址」对一下就知道浏览器是不是连到了别处。日志为空时会说明"只有本插件拉起过才会有这份日志"，而不是显示一片空白。

**两边平台都支持，但机制不同**（都是实测出来的，不是照文档写的）：

| | Linux / macOS | Windows |
|---|---|---|
| 检测 | `cmd /c ver` 没有 Windows 标记，且 `uname -s` 有输出 | `cmd /c ver` 报出 `Microsoft Windows` |
| 状态 | `ss -ltn` 或 `netstat -ltn` | `Get-NetTCPConnection` |
| 拉起 | `setsid nohup … >> log 2>&1` | 写一个 `launch.cmd`，再用 **WMI `Win32_Process.Create`** 启动 |
| 关闭 | `kill`，退回到 `fuser`/`lsof` 找持端口者 | `taskkill /T /F`，退回到端口持有进程 |

**平台是自动探测的，不需要在配置里选。** 探测顺序是先问 `cmd /c ver`、再问 `uname -s`，这个顺序有原因：装了 Git for Windows 的 Windows 机器**也有 `uname.exe`**（报 `MINGW64_NT-…`），若先信 `uname` 就会把 Windows 判成 POSIX，然后对着它跑 `setsid nohup` 与 `kill`。`cmd.exe` 是 Windows 独有的，问它不会被这样骗过。

> ⚠️ **`remoteHome` 会在远端解析成真实路径**。默认值是 `~/.dsh`，那是 POSIX 写法；在 Windows 上 PowerShell 的 `-Path` 会展开 `~`（目录能建对），但 **`cmd.exe` 不会** —— launcher 里的 `>> "~/.dsh\federation\web.log"` 于是重定向到一个不存在的路径，**日志压根不会生成**，而你看到的只是「30 秒内没等到启动 URL」加一份空日志。现在这个值会先在远端用 `$env:USERPROFILE` 解析、并把 `/` 换成 `\`。

> ⚠️ Windows 为什么不用 `Start-Process`：**Windows OpenSSH 把每个会话的命令放进 job object，通道一关子进程就被杀**（实测：连线上时写了 5 行，断开后进程消失）。WMI 创建的进程归 WMI 所有，同一实验在断开 5 秒后仍在写。另注意 WMI 返回的 pid 是 `cmd.exe` 包装器的，真正的 `node` 是它的**子进程**，所以关闭必须用 `/T` 杀整棵树——否则服务还在跑，而 pid 文件指向一个已经没了的进程。
>
> Windows 上的 PowerShell 命令一律用 `-EncodedCommand` 发送。`C:\Program Files\…` 里的空格、脚本里的引号与 `$`/`%`/`|`，会被 cmd / PowerShell / OpenSSH 三层引号中的至少一层弄坏；编码是实测唯一稳的形式。

> ⚠️ 两个前提：① 非交互 SSH 的 `PATH` 里**常常没有 `dsh`**，所以命令名可填（默认 `dsh`，不确定就填绝对路径；Windows 上也可直接填 `bin.js` 的完整路径）；② 需要知道对方的 `DSH_HOME`（POSIX 默认 `~/.dsh`，Windows 默认 `C:\Users\<你>\.dsh`）。

> **日志每次「拉起」前会被清空**，不是追加。它是读取启动 token 的来源，留着上一次的内容会把旧 token 当成这一次的结果回填到 peer 上。

---

## 安装

```sh
# 从 GitHub 安装（没有构建步骤，装完即可用）
dsh plugin --profile web add github:Hunter53323/dsh-remote-switch

# 重启使插件生效
dsh web
```

也可以从本地源码装（开发用）：

```sh
dsh plugin --profile web add link:<本目录绝对路径>
```

重启后，侧栏底部（设置按钮旁）会出现一个 🌐 图标：**实例**；侧栏的全局面板区会出现 🖧 **远端会话**。

卸载：

```sh
dsh plugin --profile web remove dsh-remote-switch
```

> 与 `@linxin666/dsh-web-all` / `dsh-remote-web-ui` 并存不冲突：本插件是独立包，两者的更新互不覆盖。代价是侧栏会多一个入口（那边是手机图标，这边是地球图标）。

---

## 用起来

### 一次性：把对方的链接给本插件

1. 到**目标实例**那台机器上，用它的 `127.0.0.1` 页面打开 **设置 → Web 插件 → 远程访问** 面板。
   （配对面板只在回环可用，这是那个插件的设计。）
2. 点**刷新二维码**，再点**复制链接**。链接形如
   `http://192.168.1.23:3080/pair-accept?pair=<一次性令牌>`。
3. 回到**本机**的 🌐 面板 →「添加实例」→ 粘贴这条链接（可选填名称）→ 添加。

本插件会在**宿主进程里**替你兑换这枚令牌：`POST <目标>/api/pair/accept` → 拿到该实例的设备凭据并落盘。
这一步在 Node 侧完成，因此**不需要**在这个浏览器里打开过对方页面，也不受同源策略限制（浏览器侧是做不到的，对方也没有 CORS 头）。

也可以直接填地址（`http://192.168.1.23:3080` 或 `https://<id>.dsh-market.com`）而不带凭据——
那样切换就依赖"这个浏览器此前在该源上取得过凭据"。

### 每次：打开别的实例

- 打开 🌐 面板，**下拉框**里选一台 → 点**打开**；或直接点列表那一行的**打开**。
- **一律在新窗口里打开**（`window.open(url, '_blank', 'noopener,noreferrer')`），**当前这个页面不动**——所以切换器、当前会话、清单都还在，回来只是切一下窗口。
- 当前所在实例会有**高亮**（用 `location.origin` 实时判定，不存状态）。
- **点面板以外的任何地方就会收起**（面板打开时铺一层透明捕获层，不走 document 监听，避免和 React 事件、侧栏层叠打架），按 **Esc** 也可以。

> 面板里**只有你存的那些远端实例**，没有"本机"这一条：面板本来就是**当前实例**的面板，再加一条本机只会指回同一个源（在别的机器上还会指向那台机器），纯属冗余。

> 为什么不做"同标签跳转"：那会**卸载当前页面**，而这个页面一旦没了，从另一台机器上没有任何办法回来（见下一节）。

### 添加/移除/测试只在 `127.0.0.1` 页面可用

在局域网或隧道地址打开的页面里，面板只允许打开实例，不允许改清单（宿主侧对这些请求返回 403）。

---

## 与"回本机"的边界

**能不能从别的实例切回本机？**

- **能**：只要那个浏览器**在本机这个源上登录过**。cookie 与 authority（`host:port`）绑定，直接打开你平时用的本机地址就进去了——不需要任何令牌。
- **不能**：**在另一台机器的浏览器里，无法从别的实例切回本机。** 三条硬约束叠在一起，无解：

  1. 本机的界面只能在**本机自己的 `127.0.0.1`** 上打开；
  2. 启动令牌**只有本机进程能铸**（`randomBytes`，进程级，只印在启动那行 stdout 上，事后取不回来）；
  3. 令牌的**生成入口在本机面板**，而你需要它的时候人在别的实例页面上——生成方和使用方永远见不到面。

  所以如果 B 在另一台机器上，`http://127.0.0.1:<本机端口>` 在那台的浏览器里指向的是 B 自己。

**这也是本插件用"新窗口"而不是"同标签跳转"的原因**：新窗口模型下本机页面永远不会被卸载，你不需要"回来"，只需要切窗口。

**那本机丢了登录 cookie 怎么办？**（换了浏览器配置、清了数据、端口变了）走到本机那台机器前，用启动时打印的那行 `dsh web: http://127.0.0.1:<端口>/?token=…` 打开一次即可——那行 URL 就是官方的补登录入口，本插件不再自己造这个链接（造出来也没法从别的机器用）。

**为什么重启不影响已配对（关键区分）**

这里有两枚 cookie，别混：

| | 启动令牌（URL 里的） | 会话 cookie |
|---|---|---|
| 生成 | `randomBytes`，进程内缓存 | 一次性生成，**持久化在凭据库** |
| 寿命 | **每次 `dsh web` 重启都换** | 长期有效（cookie 自带 `expiresAt`） |
| 作用 | 只是**兑换 cookie 的输入** | 之后每个请求校验的就是它 |

校验路径只核对 cookie 的签名与过期时间，**不看当前进程的启动令牌**。所以 `dsh web` 重启后：老的**配对仍然有效**，而启动时打印的那行带令牌 URL 会换新。

---

## 存储与配置

清单落盘在 `$DSH_HOME/instance-switcher/peers.json`（默认 `~/.dsh/instance-switcher/peers.json`，0600 尽力而为、临时文件 + 原子改名）：

```json
{
  "version": 1,
  "peers": [
    {
      "id": "p-1a2b3c4d5e6f",
      "label": "build-box",
      "origin": "http://192.168.1.23:3080",
      "credential": "……",
      "createdAt": 1789626419090,
      "lastUsedAt": 1789626470123
    }
  ]
}
```

清单里**只存远端实例**。本机条目（早期版本会发布一条 `__local__`）已删除——面板属于你当前所在的实例，那条只会指回同一个源；`__local__` 这个 id 仍被拒绝，以免旧文件把它当成真条目塞回来。

插件配置（profile 的 `cordis.patch.yml` 覆盖行）：

```yaml
- id: instance-switcher
  config:
    peersFile: 'D:/somewhere/peers.json'   # 可选：换清单位置
    requestTimeoutMs: 6000                 # 可选：兑换/探活超时
    targetCookieName: 'dsh_pair'           # 可选：对方改了设备 cookie 名时
    deviceCookieName: 'dsh_pair'           # 可选：读取端认哪个设备 cookie 名
    federation:                            # 远端会话面板（全部可选）
      federationFile: 'D:/somewhere/federation-peers.json'
      knownHostsFile: 'D:/somewhere/known_hosts.json'
      cacheFile: 'D:/somewhere/federation-credentials.json'
      hostKeyPolicy: 'accept-new'          # accept-new | verify | off
      pollIntervalMs: 15000
      requestTimeoutMs: 12000
      listLimit: 100
      remoteHome: '~/.dsh'                 # 拉起/关闭时对方那边的 DSH_HOME
      provisionReadyTimeoutMs: 30000       # 等对方打印启动 URL 的上限
```

### 联邦 peer 的存储

`$DSH_HOME/federation/peers.json`（0600，临时文件 + 原子改名），与实例清单**分开存**：

```json
{
  "version": 1,
  "peers": [
    {
      "id": "f-1a2b3c4d5e6f",
      "channel": "ssh",
      "label": "build-box",
      "origin": "http://127.0.0.1:3080",
      "webOrigin": "http://192.168.1.23:3080",
      "ssh": { "host": "192.168.1.23", "user": "me", "port": 22, "remotePort": 3080, "privateKeyPath": "C:/Users/me/.ssh/id_ed25519" },
      "auth": { "kind": "token", "token": "……" },
      "createdAt": 1789626419090
    }
  ]
}
```

分开存是有意的：实例清单里那条 `credential` 是**对方远程访问通道的设备凭据**，而联邦 peer 描述的是**怎么连过去**；混在一张表里会让一种凭据被当成另一种用。

登录 cookie 缓存在 `$DSH_HOME/federation/credentials.json`（存在 `ctx.credentials` 服务时优先走它）。**改凭据（换 token/密码）会作废该 peer 的 cookie 缓存**——否则新 token 会被旧 cookie 静默压住。

### 已删除的功能，别去找

- **改「本机」地址**（面板里编辑 / `config.localUrl`）
- **生成「回本机直达链接」**（`/api/instance-switcher/local-link`）

两者都是为"从别的实例切回本机"服务的，而那件事**在任何配置下都做不到**（见上文三条硬约束）。留着只会让人以为能回去。

---

## 安全

- **清单里的凭据是"完全控制凭据"**：`<origin>/pair-app?device=<凭据>` 能直接进入那台实例的官方 GUI，而配对设备在 DSH 里等同于完全控制。这条记录等于本机存了**别人家机器的钥匙**，请按敏感文件对待。
- 令牌是**一次性**的：兑换成功后原链接即失效。所以别把「复制链接」的结果随手贴到群里。
- 修改清单的接口**只应答回环**（回环 socket 且回环 Host 同时满足），远端页面改不了。
- 读取清单的 `GET /api/instance-switcher/peers` **只发给回环源，或持有活的已配对设备会话的请求**——清单里含每台实例的设备凭据，而直接注册在 web server 上的路由**不受** harness 那层 `/api` 认证保护，必须自己把关（早期版本曾把它发给任何人，已修）。
- **`/api/federation/*` 一律只应答回环，读取也不例外**：联邦 peer 里存着 SSH 密码/私钥路径与对方启动 token，而且这条路径**没有**"已配对设备"这种合理例外。响应里也**永不下发凭据原文**（token 与密码只以 `hasToken` / `hasPassword` 布尔位出现）。
- **跳转 URL 由宿主组装**：面板拿到的是拼好的 URL，对方的 device 凭据不进浏览器。

---

## 验证

```sh
npm run verify:host         # 实例切换器宿主半：真实令牌兑换 → 落盘 → 探活 → 回环围栏（需本机有实例在跑）
npm run verify:client       # 浏览器半：加载器契约 + 槽位注册 + 双语文案 + 两个面板的数据通路与动作
npm run verify:federation   # 联邦半：SSH 隧道 → 真实会话清单 → 过滤/分组 → 凭据缓存 → 启停（替身 sshd）
npm run verify:provision    # 端到端：真的拉起一个 dsh web，读回它的 token，并确认那个 peer 立刻可读
npm run verify:static       # 静态兜底：解真实会话文件的 zstd 首帧 + 合成边界用例 + 降级决策（不需实例）
```

另有一个**真远端**验证脚本（不随 npm script 跑，需要网络可达）：

```sh
node scripts/verify-real-remote.mjs --host <ip> --user <name> [--password <pw>]
```

它只做只读操作：连一台真机器、开 SFTP、读目录与 header 帧。它的价值在于——**ssh2 的 SFTP 是回调式 API**，写错适配器会静默拿到 `undefined`（看起来像"那台机器没有会话"），这个坑只有对着真的 ssh2 服务器才会暴露。机器上没有 `sessions/` 时它会明确 SKIP 而不是假装通过。

还有一个针对 **Windows 远端**的验证脚本（同样需要网络可达）：

```sh
node scripts/verify-windows-remote.mjs --host <ip> --user <name> [--password <pw>]
```

它回答两个**分开的问题**，不混在一起：① 我的机制在 Windows 上是否成立（写 launcher → WMI 分离 → 记 pid → 轮询日志取 token → `taskkill /T` 关闭），用端口 `3099` 和一个**替身入口脚本**验证，不依赖那台机器的 dsh 装得好不好；② 那台机器**自己的** `dsh web` 能否启动——这取决于它的 profile，所以只**报告**不判定。它不会碰对方已经在跑的 3080，并在任何路径下清理自己留下的文件。

`verify:host` 会**真的**在你的实例上铸一枚令牌并兑换（留下一条设备记录），验证完可用面板的「停止」或逐设备取消配对准掉。

`verify:federation` / `verify:provision` 各需要自己的前提：

```sh
# 联邦半：需要一台一次性实例（独立 DSH_HOME + --port 0）及其启动 token
pwsh -File scripts/test-instance.ps1 -Action setup        # 摆好隔离 profile（只需一次）
pwsh -File scripts/test-instance.ps1 -Action start        # 后台跑；读它打印的 token
node scripts/verify-federation.mjs --target http://127.0.0.1:<端口> --token <token>

# 端到端拉起：不需要外部实例，它自己拉起一个再关掉
node scripts/verify-provision-e2e.mjs
```

收尾：`pwsh -File scripts/test-instance.ps1 -Action cleanup`。

`verify:federation` 在本地起一个 `ssh2` Server 当替身 sshd，把 `direct-tcpip` 转发到那台实例——因此**不需要真的远端机器**就能端到端验完传输、凭据兑换、unary 信封、流 mux 首帧、过滤逻辑与启停命令的构造。

`verify:provision` 更进一步：替身 sshd **真的执行**那条启动命令（用本机的 `dsh web --port 0`，独立 DSH_HOME 假装是远端），于是"拉起 → token 被捕获并落盘 → 那个 peer 立刻能读 → 关掉后确实不可读"整条链是被证明的，而不是排练的。

`verify:static` 不需要任何实例：它拿**本机真实的会话文件**跑静态读取（并断言只读首帧、子会话被滤掉、行都标了 static），再用自己合成的用例覆盖本机 corpus 里没有的边界（超大 header 帧、明文工件、版本 0 命名、损坏帧、空目录、扫描上限），最后断言那两条**降级决策**：实例不可达 → 用静态清单；被 403 拒绝 → **不**降级。

浏览器端的**点击路径**（真的弹出窗口、面板的实际排版）需要人工在浏览器里过一遍：本仓库的 client 校验用一个自研的精简 renderer，对嵌套子树的深度复刻不可靠，因此只断言到"面板拿到了完整的多实例状态"、目标 URL 的构造（纯函数 `__entryUrlFor`）与宿主侧契约。

---

## 已知限制

- **是"开新窗口"，不是同屏嵌入**：跨源 iframe 里目标实例的两枚 cookie 都是 `HttpOnly` 且 `SameSite=Strict/Lax`，浏览器不会在跨站子请求里发送，所以嵌套页面进不去（或进来后所有 `/api` 调用 401）。改为新窗口后，本页与切换器始终在，回来只需切窗口——代价是多了个窗口。
- **从别的机器上无法切回本机**（原理见上文三条硬约束）。本机 cookie 丢了的补救方式是到本机那台机器上用启动时打印的 `?token=` URL 打开一次。
- 目标实例**必须**运行 `@linxin666/dsh-remote-web-ui`（提供 `/pair-app` 与 `/api/pair/accept`）。对方没装时，「添加实例」会报 `pair-redeem-failed` 并提示原因。
- 凭据失效（对方撤销、超过 30 天空闲）时「测试」会显示**凭据已失效**，此时需要重新走一次"复制链接 → 粘贴"。
- **会话面板只能跳到对方首页，不能直达某一条会话**：远端 GUI **没有**任何会话级 URL（无 SPA 路由/fallback，会话选择是纯内存态）。这不是本插件的取舍，是对方界面的事实。
- **会话面板的 `running` 是轮询快照**（默认 15s 一次，失败后退避），不是实时推送——滞后不超过一个间隔。
- ⚠️ **远端每次启动都会换 token，旧的立刻作废**。实测（同一个 `DSH_HOME`、只差一次重启）：上一次启动打印的 token 拿去 `GET /?token=…` 得到 **401**，本次启动的得到 303 + cookie（同一个 token **可以重复兑换**，作废它的是重启而不是"用过一次"）。所以**对方一重启，你存的 token 就过期了**，必须重新取——不用手抄，点「**重启并重新捕获 token**」即可（它先关闭再拉起，因为日志只在拉起那一刻清空）。这也解释了两类不同现象：**面板连会话都列不出来（401）** = token 过期了；**面板正常但「打开远端」停在登录页** = 插件版本旧、跳转地址里没带 token（0.2.1 起才带）。
- ⚠️ **`dsh web authentication required; reopen the URL printed by dsh web.` 是 harness 自己的 401 页**（`dsh-client-connection`），它的判定规则值得记住：URL 上**带了 `token` 参数时**，先按 token 兑换；token 对不上时**如果 cookie 有效仍会 303 跳回干净的 `/`**（所以一个坏 token 不会把你锁在门外），两者都不行才是 401。也就是说 **401 = 浏览器没有该 authority 的有效 cookie，且 URL 里的 token 与当前实例不匹配**。据此有个实用结论：**成功打开过一次 token URL 之后，浏览器就有 cookie 了，之后裸的 `http://ip:端口/` 一直能用**（值得直接收藏那个裸地址）。反过来，如果地址栏里已经挂着旧的 `?token=`，别反复刷新它——从面板重新点一次「打开远端」拿到的是当前 token。
- 远端**一条损坏的会话文件会打挂它的整个列表**（`gateway/internal: session persistence listing failed`）；面板会把这个原因直接讲出来，但清理得在远端做。
- SSH 通道的「跳转地址」需另填，否则只能列清单不能跳（见上文）。
- **静态兜底的能力边界**：只支持 SSH 通道；需要对方的 `DSH_HOME`；不知道运行状态 / 空白会话 / 真实标题 / 归档状态（面板会逐条说明）；远端未运行时每条会话都要读一个文件，所以默认最多扫 500 个。
- `PeerProvisioner` 支持 **POSIX 与 Windows** 远端，但**不支持 SSH agent 认证**；Windows 上还需要 PowerShell 与 CIM 可用（Windows 10/11 与服务端版本默认都有）。
- **远端 `dsh web` 起不来时，面板会附上远端日志末尾**。真正的原因几乎总在那里（缺包、端口被占、`DSH_HOME` 不对），只看错误码是查不出来的。
- **`session/follow` 只读事件预览不做**：静态兜底已经覆盖了它要解决的核心场景，而事件预览要在只读约束下解多帧、分页、并定义"最近若干条"的口径，收益与风险不成比例。

---

## 目录

| 文件 | 作用 |
|---|---|
| `lib/index.js` | 宿主半入口：挂载两个表面（`instance-switcher` + `federation`） |
| `lib/peers.js` | 纯逻辑：地址规范化、配对链接解析、实例清单读写、`entryUrl` |
| `lib/http.js` | 两个表面共用的路由小工具与**回环栅栏** |
| `lib/federation/wire.js` | harness Remote 的 wire 常量与信封编解码 |
| `lib/federation/visible.js` | 复刻远端可见性过滤、标题回退、按 cwd 分组 |
| `lib/federation/store.js` | 联邦 peer 的存储与校验 |
| `lib/federation/ssh.js` | SSH 传输：连接复用、TOFU host key、`direct-tcpip`、`exec`、`sftp` |
| `lib/federation/auth.js` | 凭据：token→cookie 兑换、按 authority 缓存、回放、401 重换 |
| `lib/federation/client.js` | 会话清单与工作区基线的读取（HTTP + WS mux）+ 静态兜底的降级决策 |
| `lib/federation/static.js` | 远端未运行时经 SFTP 解会话文件首帧 zstd 取 header |
| `lib/federation/provisioner.js` | 经 SSH 拉起/关闭远端 `dsh web`（POSIX 与 Windows 两套机制），并读回它打印的 token |
| `lib/federation/index.js` | 联邦路由与**单例轮询器** |
| `lib/client.js` | 浏览器半：侧栏入口 + 两个面板 + 双语字典（手写 loader 懒加载 CJS，无需构建） |
| `cordis.patch.yml` | bundle patch：只插入本插件一行 |
| `scripts/verify-host.mjs` | 实例切换器宿主半端到端验证 |
| `scripts/verify-client.mjs` | 浏览器半契约、双语与两个面板的行为验证 |
| `scripts/verify-federation.mjs` | 联邦半端到端验证（本地 ssh2 Server 替身） |
| `scripts/verify-provision-e2e.mjs` | 拉起/关闭的真实端到端验证（真的启动一个 `dsh web`） |
| `scripts/verify-static.mjs` | 静态兜底验证（真实会话文件 + 合成边界用例 + 真 ssh2 SFTP 服务器） |
| `scripts/verify-real-remote.mjs` | 真远端只读验证（需网络可达；无 `sessions/` 时 SKIP） |
| `scripts/verify-windows-remote.mjs` | 真 Windows 远端的启停机制验证（需可达；不碰对方在跑的实例） |
| `scripts/test-instance.ps1` | 隔离测试实例的 setup/start/stop/cleanup |
