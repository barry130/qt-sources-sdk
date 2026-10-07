# 音源包作者指南（PACK-AUTHORING）

面向想给 QTMusic（qt-uniappx 安卓端 / qt-pc 桌面端）写**播放音源包**的作者。
读完后你应该能：从零写出一个可安装、可更新、可被宿主信任的 `.js` 音源包。

配套模板：[`examples/hello-play-pack.js`](../examples/hello-play-pack.js)（手写免构建，
可直接安装，装上后任何歌都会播放同一段演示音频——听到声音就说明你的包整条链路走通了）。

---

## 1. 30 秒理解包模型

- 音源包就是一个 `.js` 文件，用户通过 **https 直链**或**本地文件**安装
  （设置 → 音源包管理）。宿主不执行包体就能先读出「自述身份头」。
- 两种包：
  - `kind:"play"` **播放包**：只负责一件事——给一首歌返回播放地址
    （`getPlayUrl`）。**第三方作者写的就是这种**。
  - `kind:"meta"` **数据包**：搜索/歌单/歌词/封面等元数据面，目前仅官方渠道
    发布，暂不对第三方开放。
- 每个包按 `id` 独立管理版本：同 `id` 的新 `versionCode` 覆盖旧版（更新），
  不同 `id` 互不影响、可共存切换。
- 安装时宿主会**冒烟自检**（真取链 + Range 预检），失败自动回滚；包代码跑在
  沙箱引擎里，只有宿主注入的 `request` 能力可用（无 fetch / DOM / 文件系统）。

## 2. 首行自述头（必须）

整个文件第 1 行必须是一条块注释，内嵌 JSON：

```js
/*__QT_PACK__{"kind":"play","id":"my-cool-pack","name":"我的音源包","versionCode":3,"versionName":"1.2.0","updateUrl":"https://example.com/my-cool-pack.js"}*/
```

| 字段 | 必填 | 规则 |
|---|---|---|
| `kind` | ✅ | 第三方包固定 `"play"` |
| `id` | ✅ | `^[a-z0-9-]{2,32}$`（小写字母/数字/连字符）。**包的终身身份**，发布后不可改；官方保留 id 需官方签名才能安装（见 §7） |
| `name` | ✅ | 展示名（列表里显示，可中文） |
| `versionCode` | ✅ | ≥1 的整数，**只增不减**。宿主拒绝降级，重复码视为「已装过」 |
| `versionName` | ✅ | 展示版本（如 `"1.2.0"`），与 `versionCode` 无强制对应 |
| `updateUrl` |  | 包自己的 https 直链。声明后宿主**每次启动**探测该链接的首行头，发现新 `versionCode` 就提示用户更新（用户确认才下载）。不填 = 纯手动安装 |
| `notes` |  | 一句话说明（安装预览里展示） |

规则：

- JSON 里不能出现 `*/` 序列（会提前终止注释头）——`updateUrl` 带路径没问题，别带 `*/`。
- 头必须真的是**第 1 行**，前面不能有空行/BOM。
- `versionCode` 纪律：每次发布新文件必 +1。忘了 +1 用户永远收不到更新。

**保留 id**：`play-official` / `meta-official` 是官方包专用。官方包带发布方
ed25519 签名（见 §7），宿主对这两个 id 做硬校验——你用了它们且没有官方
私钥签名，安装会直接被拒绝（不是警告，是装不上）。别用。

## 3. play 包代码契约

### 3.1 形态

- **普通脚本**（IIFE 或顶层代码），顶层**不能**有 `import` / `export`
  （宿主用 `new Function(code)()` 求值，不是当模块编译）。
- 求值后的唯一顶层副作用：把工厂挂到全局——

```js
globalThis.__qtPlayPackFactory = function (host) {
  // host = { request, log?, platform? }（宿主能力，见 3.2）
  return {
    name: "my-cool-pack",
    version: "1.2.0",
    getPlayUrl: async function (args) { /* 见 3.3 */ },
    loadChain: function (chainJson) { /* 见 3.4 */ },
    bundleInfo: function () { /* 可选，诊断 */ },
  };
};
```

- 工厂会被立即调用一次，返回值被宿主持有；你的包被更新/切换时旧实例直接
  丢弃，**无需**（也无法）处理卸载逻辑。

### 3.2 宿主注入的能力 `host`

| 字段 | 类型 | 说明 |
|---|---|---|
| `request` | `(url, options?) => Promise<response>` | **唯一的联网通道**。`options = { method: "GET"\|"POST", headers?: Record<string,string>, body?: string, timeoutMs?: number }`（默认 GET / 15s）。`response = { statusCode: number, headers: Record<string,string>（名全小写，Set-Cookie 会透传）, body: unknown（宿主已尝试按 JSON 解析；**别按 content-type 判断**，上游普遍用 text/plain 装 JSON 体） }` |
| `log` | `(message: string) => void` | 调试日志通道（缺失时自行忽略） |
| `platform` | `number` | 宿主平台号：1101 安卓 / 1102 iOS / 1103 Windows；缺省按安卓 |

没有 fetch / XHR / DOM / 定时器之外的 Node API。需要 Referer/UA 伪造就在
`options.headers` 里传——宿主统一执行，你只负责拼参数和解析响应。

### 3.3 `getPlayUrl(args)` —— 唯一的核心

入参 `args`（宿主把正在播放的歌映射过来）：

```json
{ "platform": "kw", "id": "234567", "name": "晴天", "singer": "周杰伦",
  "album": "叶惠美", "quality": "320", "duration": 269 }
```

- `platform`：源 id，`"wyy" | "qq" | "kw" | "kg"`（当前注册表；官方数据包经
  `__qtEntries.sourceRegistry()` 动态声明源与音质清单，宿主 UI 与入参枚举都随
  数据包版本变化——你的包应把它当作任意字符串处理，遇到不认识的 id 抛错即可）；
  `quality`：`"128" | "320" | "flac"`（当前档位）。
- `id` 是这首歌在 `platform` 源上的 id（跨源兜底场景下建议先按 name/singer 搜索定位）。

成功：resolve **JSON 文本**：

```json
{ "url": "https://...", "source": "kw", "quality": "320",
  "line": { "id": "kw-free", "name": "酷我免费", "kind": "free", "targetSong": null } }
```

- `url` 必须是**可直接播放**的音频地址（宿主会先发 Range 预检，预检不过等于失败）；
- `line` 描述本次命中的线路（没有线路概念就传 `null`，宿主显示「未知」）；
  `targetSong` 仅在跨源命中（返回的其实是别的平台上的这首歌）时传
  `{ platform, id, name, singer }`，宿主用它精确取词。

失败：**throw Error**（或 `Promise.reject`）。错误文本是用户在界面能看到的唯一
诊断信息，请写清死因（如 `"kw 线路A：签名超时"`），别只写「失败」。宿主收到错误
后会回退内置取链，用户播放不中断——所以**宁可抛错，不要返回空串或假地址**。

### 3.4 `loadChain(chainJson)` —— 可选的配置装载

宿主会把用户导入的链路配置（JSON 文本）递给你。不需要配置的包返回
`JSON.stringify({ ok: true, lines: 0 })` 即可；配置非法时抛错。

### 3.5 `bundleInfo()` —— 可选诊断

返回 JSON 文本（你自己的结构），装配后调试用，宿主不透传给界面。

## 4. 生命周期：你的包会经历什么

1. **安装预览**：宿主下载/读完文件 → 解析首行头 → 官方 id 先过签名硬校验
   （假官方包直接报错，到不了预览）→ 内容安全扫描（§6，第三方包命中红线
   直接拒绝）→ 给用户看类型/名称/版本/id/来源（官方包展示「已验签」）→ 用户确认。
2. **落盘+登记**：文件写入 `install/<id>/`，旧版本备份为 `.prev`。
3. **装配**：`new Function(code)()` 求值 → 工厂调用 → API 挂到引擎。
4. **冒烟自检**：宿主拿几首真实歌调 `getPlayUrl` + Range 预检。
   通过 → 生效（清播放地址缓存）；不通过 → 更新场景自动**回滚旧版本**，
   首次安装则保留文件、列表标注「上次失败」。
5. **更新**：三渠道——官方 manifest（仅官方包）、你声明的 `updateUrl`
   （启动时探测，用户确认后下载）、用户手动重装。更新失败一律回滚。
6. **卸载/切换**：删目录出列表 / 热切换到别的包，你的代码无需感知。

## 5. 发布检查单

- [ ] 首行头在第 1 行，JSON 可解析，`*/` 恰好一个
- [ ] `id` 合规（`^[a-z0-9-]{2,32}$`）且不撞 `play-official` / `meta-official`
- [ ] `versionCode` 比上一版 +1
- [ ] 顶层无 `import` / `export`（打包工具配置成 IIFE 输出，`formats:["iife"]`）
- [ ] 不含 §6 红线词（含字符串字面量里的）；联网只走 `host.request`
- [ ] 只用 `host.request` 联网；请求头按需伪造；响应体别按 content-type 猜格式
- [ ] `getPlayUrl` 失败抛带死因的 Error，绝不返回假地址
- [ ] 用真机装一遍：能过冒烟、能播放、再发一版能收到更新提示
- [ ] 分发链接是 **https 直链**（宿主拒绝 http）；`updateUrl` 指向同一文件的最新版

## 6. 内容安全红线：安装扫描（2026-10 起生效）

签名（§7）只管官方身份；**内容安全**对所有包一视同仁。安装时宿主会扫描包
文本（剥掉尾部签名块后的全文），第三方包命中下列任一特征**直接拒绝安装**，
错误信息会给出命中词与行号：

| 类别 | 命中特征 | 说明 |
|---|---|---|
| 宿主桥 | `__TAURI_INTERNALS__`、`__TAURI__`、`ipcRenderer`、`webkit.messageHandlers`、`UTSAndroid`、`io.dcloud` | 尝试触碰宿主/系统原生桥（PC 的 Tauri IPC、Electron/WKWebView、uni-app 原生层） |
| 直连网络 | `WebSocket`、`EventSource`、`sendBeacon`、`new XMLHttpRequest`、全局 `fetch(`、`require(` | 绕过 `host.request` 的自由外联面（含把数据编码进 URL 的上报） |
| 后台执行体 | `importScripts`、`new Worker(`、`ServiceWorker`、`serviceWorker` | 引擎生命周期管不到的执行体 |
| 本地/Node 面 | `child_process`、`process.binding`、`content://` | 引擎环境本就不该出现的系统能力 |

形态说明与误报规避：

- `fetch(` / `require(` 认**调用形态**：前一字符是字母/数字/`_`/`$`/`.` 的不算。
  所以 `backend.fetch(songId)`、`prefetch(url)`、`myrequire(x)` 这类方法名/
  长词**不会**误伤；裸 `fetch(url)`、`await fetch(url)` 才拦。
- 其余按**纯文本子串**匹配——注意别在字符串字面量/注释/变量名里拼出这些 API
  名（例如请求头值 `'XMLHttpRequest'` 是官方包里的真实良性写法，但作为第三方
  包会被拦：换个写法，如 `'XMLHttp' + 'Request'` 之外的命名，或直接不用它）。
- **刻意不拦** `eval(` / `Function(`：crypto-js 等加密库内联时的
  `Function("return this")()` 环境探测是标配，正常使用不受影响。
- 官方包（已通过 §7 签名校验的 `play-official` / `meta-official`）命中只记
  日志不阻断——签名即内容背书；第三方包没有这层背书，红线就是红线。

这不是唯一防线，而是最响的一道警报。就算某条静态规则被绕过，运行时引擎里
也没有第二条路：包代码能用的全部能力就是下表，其余一律 `undefined` 或抛错：

| 运行时能力 | 有无 |
|---|---|
| `host.request`（受管控的 HTTP，协议/内网校验在宿主侧） | ✅ 唯一网络出口 |
| `host.log` / `host.platform`、纯 JS 计算、`JSON`/`Date`/正则/定时器 | ✅ |
| `fetch` / `XMLHttpRequest` / `WebSocket` / `EventSource` / `sendBeacon` | ❌ 已收缴（调用即抛错） |
| `Worker` / `SharedWorker` / `ServiceWorker` / `importScripts` | ❌ 已收缴 |
| 宿主桥（Tauri IPC / 原生 bridge / `plus` / Node API / 文件系统） | ❌ 不存在 |
| `eval` / `Function`（动态执行） | ⚠️ 可用但无利可图——上面全是空的，动态执行变不出新能力 |

## 7. 官方包签名（第三方作者可忽略）

官方发布渠道与第三方完全一样（https 直链 / 本地文件），所以官方身份不靠
渠道、只靠内容签名：

- 官方包在发布时由构建机用 ed25519 私钥对**包全文**（含首行身份头、剥掉
  尾部签名块）签名，文件最后追加一条注释块：

  ```js
  /*__QT_SIGN__{"alg":"ed25519","sig":"<base64 的 64 字节签名>"}*/
  ```

- 宿主（安卓端 / PC 端）内置官方公钥，对 `play-official` / `meta-official`
  两个保留 id 做硬校验：缺签名块、签名对不上（文件被改过一字节）一律
  拒绝安装/更新，与来源渠道无关。
- **第三方包完全不受影响**：不需要签名、不用申请密钥、流程一步没变；
  也不要去伪造官方签名——没有私钥签不出来，公钥验签是单向的。
- 签名块必须整个在文件**最末尾**（后面只允许空白）。发布流程属于构建仓内部，
  第三方作者不需要也不需要关心——这套机制只约束官方的两个保留 id。

## 8. 常见问题

**Q：我的包能改搜索/歌单/歌词吗？**
不能。那些属于 `kind:"meta"` 数据包，目前仅官方发布。播放包只管取链。

**Q：加密算法 / zlib 要自己带吗？**
要。包是一个自包含脚本，依赖全部内联（参考官方包的做法：加密模块原样内联）。

**Q：一次安装多个播放包会怎样？**
共存且可随时切换，同一时刻只有一个生效。列表里每行能看到来源（链接/本地/官方）
与最近失败原因。

**Q：用户怎么信任我的包？**
安装预览会展示完整身份（id/版本/来源）供用户确认；安装期内容安全扫描
（§6）+ 运行时能力收缴兜底，包做不了取链以外的事。请在 `notes` 里写清包的
用途。（官方包另有一层 ed25519 签名硬校验，见 §7；那是官方身份专属，第三方靠口碑。）

**Q：用了官方 id 会怎样？**
`play-official` / `meta-official` 是官方保留 id。没有官方私钥签名的文件
自称这些 id，宿主直接拒绝安装（明确报「签名校验失败」）。这是防仿冒设计，
正常作者不受影响。
