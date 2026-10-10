# 洛雪源 → qt 播放包：打包方案

把 **LX Music（洛雪音乐）自定义音源脚本**打包成轻听 QuietMusic 的
**播放包**（`.js`，单文件、免构建、可直接安装）。本方案覆盖：格式、动作映射、
运行时桥设计、内容安全预检、能力边界，以及 CLI / SDK 两种用法。

> 范围声明：**只做播放包（仅取链）**。搜索 / 歌词 / 封面属于 qt 的 **meta 包**
> （数据包）职责，不在本工具产出范围——详见 [能力边界](#能力边界)。

---

## 0. 一分钟速览

```bash
# 一个命令，把洛雪源变成可安装的播放包
node scripts/build-lx-pack.mjs "洛雪音乐源.js" --id my-lx-source

# 产物：my-lx-source.js —— 客户端「设置 → 音源包」→「安装音源包」→「从本地文件」选它
```

产物 = 首行包头 + 洛雪运行时（内嵌）+ 源脚本原文（内嵌）+
`__qtPlayPackFactory(host)`。装上后，任意平台的取链都会走洛雪源的
`musicUrl` 动作。

---

## 1. 为什么有这份方案（背景）

qt 原生只认两种第三方交付物，职责分得很清：

| 交付物 | 职责 | 宿主校验 |
|---|---|---|
| **播放包**（`kind:"play"`） | 播放地址（取链），即「给首歌曲返回可播 URL」 | 内容安全扫描，命中红线即拒装 |
| **meta 包**（`kind:"meta"`） | 搜索 / 歌词 / 封面等**数据** | 同上；另要求发布方签名 |

洛雪自定义源本身就是「取链器」（`musicUrl` 动作），和播放包的职责**天然对齐**，
所以选播放包形态，压缩映射成本、也把宿主的安全要求降到最低。

---

## 2. 播放包格式（产物长什么样）

```
第 1 行  /*__QT_PACK__{"kind":"play","id":"…","name":"…","versionCode":1,"versionName":"…"}*/
IIFE { 洛雪运行时源码（lx-runtime.js 的工厂函数，toString 内嵌）
        洛雪源脚本原文（JSON 字符串常量，U+2028/29 已转义）
        globalThis.__qtPlayPackFactory = function (host) { … } }
```

- `src/contract.ts` 是构建仓的逐字镜像，包格式的权威定义在构建仓
  `source_pack_header.rs`（包头）与宿主侧的解析流水线里；
- 包体是**普通脚本**（顶层无 import/export），求值后挂
  `__qtPlayPackFactory`——与手写包（`examples/hello-play-pack.js`）完全同构，
  宿主看不出区别；
- **包头行只有一行，只读它**。因此包内任何用户来源文本都不能让
  `/* … */` 提前闭合——`@name` 行常以 `*/` 结尾，打包器会把包头 JSON 与
  banner 里的用户文本统一做 `\u002f` 转义（这是合法的 JSON 转义，宿主
  `JSON.parse` 后无损还原）。

## 3. 洛雪源 → qt 播放包的映射

### 3.1 动作表

| 洛雪动作 | qt 侧 | 状态 |
|---|---|---|
| `musicUrl`（/ `lx_MUSIC_URL`） | `QtPlayPackApi.getPlayUrl(args)` | ✅ 本方案实现 |
| 搜索 `search` | meta 包 `searchLocal` 等 | ❌ 不在播放包职责 |
| 歌词 `lyric` | meta 包歌词接口 | ❌ 同上 |
| 封面 `pic` | meta 包图片接口 | ❌ 同上 |
| 播放数/评论等 | — | ❌ 不在任何包 |

### 3.2 取链请求怎么映射

qt `getPlayUrl(args)` → 洛雪 `musicUrl` 请求：

```js
{
  action: "musicUrl",
  source: mapPlatform(args.platform),       // qt id → 洛雪协议名，见 §3.2.1
  info: {
    musicInfo: {
      songmid: args.id, id: args.id, hash: args.id,
      rid: args.id, copyrightId: args.id,   // 五个 id 别名同值：
                                            // tx/wy→songmid、kg→hash、
                                            // kw→rid/songmid、mg→copyrightId
      name: args.name, singer: args.singer,
      albumName: args.album, album: args.album,
      picUrl: "", interval: args.duration ?? 0,
    },
    type: "128k" | "320k" | "flac" | "flac24bit",   // 由契约音质映射
  },
}
```

### 3.3 平台 id 映射（踩过坑，必须做）

qt 的平台 id 与洛雪协议名**不是同一套**：

| qt id | 洛雪协议名 | 平台 |
|---|---|---|
| `wyy` | `wy` | 网易云音乐 |
| `qq` | `tx` | QQ 音乐 |
| `kg` | `kg` | 酷狗 |
| `kw` | `kw` | 酷我 |
| `mg` | `mg` | 咪咕 |
| `yt` / `bili` | `yt` / `bili` | YouTube / 哔哩哔哩 |

只有**网易云与 QQ 两处不恒等**，映射一律 `QT_TO_LX_SOURCE[source] || source`。
把 `wyy` 原样丢给脚本会直接炸在脚本内部——洛雪源的典型写法是

```js
const apis = { wy: { musicUrl: … }, tx: { musicUrl: … }, kw: { musicUrl: … } };
on(EVENT_NAMES.request, ({ source, action, info }) => apis[source].musicUrl(info.musicInfo, info.type));
```

`apis["wyy"]` 是 `undefined`，用户看到的是 `Cannot read properties of undefined
(reading 'musicUrl')` 这种天书。运行时在 `getUrl` 入口就把 qt id 翻成洛雪名，
`claimedQualities()` 也接受两种写法。

> 反向映射（洛雪名 → qt id）在 `LX_TO_QT_SOURCE`。注意 `registeredSources()` 返回的是
> **脚本自己上报的洛雪名**（原始真相），装配方要按这张表翻成 qt id 再和自己的源列表比对。

### 3.4 音质映射

| 契约 | 洛雪 |
|---|---|
| `"128"` | `"128k"` |
| `"320"` | `"320k"` |
| `"flac"` | `"flac"` |
| `"flac24bit"` / `"hires"` | `"flac24bit"` |

### 3.5 平台上报

脚本 `lx.on("inited", …)` 上报的 `sources` 会被记下，经
`registeredSources()` / `claimedQualities(source)` 暴露给装配方，用于
「源支持哪些平台、宣称哪些音质」的能力探测。

---

## 4. 运行时桥设计（核心）

洛雪脚本假设自己活在一个「浏览器 + 少量 Node」的环境。qt 播放包运行在
宿主引擎窗口里，不能直接给它真环境，所以打包器把**整个运行时**内嵌进产物：

### 4.1 为什么是 `new Function` + 形参遮蔽（而不是构建仓的静态包装）

构建仓 `qt-sources/scripts/gen-lx-vendor.mjs` 在**构建期**生成静态包装：
`(function (globalThis, process, lx, SCRIPT_MD5, console, window) { <脚本原文> })(…)`
，形参**遮蔽**同名标识符、其余裸标识符落真实全局。它必须静态生成，因为
引擎页 CSP 禁 `eval` / `new Function`。

本 SDK 的包在**装配期**执行，而宿主的内容安全扫描（`pack_safety.rs:17-22`）
**刻意不拦 `eval(` / `Function(`**——crypto-js 的 `Function("return this")()`
探测是内联加密库标配，拦了会误杀主流第三方包。所以这里可以在运行时用
`new Function` 达到与静态包装完全一致的效果，这是**被放行的安全面**，
不是绕过。

```js
new Function(
  "globalThis,window,self,process,lx,SCRIPT_MD5,console,Buffer,require,module,exports,setTimeout,setInterval,setImmediate",
  scriptText + "\n;return { onRequest, onEvent };",  // v1 入口回收
)(...shadowArgs);
```

### 4.2 修掉的两个构建仓缺陷（不是风格差异）

1. **`setTimeout` / `setInterval` 做成形参**。构建仓把它们放在 globalThis
   Proxy 的 overrides 表里，但裸标识符 `setTimeout` 词法上直接落真实全局、
   根本不走 Proxy——那条防反调试的拦截实际是空的。只有形参才拦得住混淆脚本
   的定时器回调试回调（回调统一包 try/catch，异常不外抛）。
2. **额外遮蔽 `Buffer` / `require` / `module` / `exports`**，把 Node 方言
   脚本也接住；`process.exit` 抛错阻断（部分脚本用 exit(1) 反调试）。

### 4.3 自包含纪律

运行时 `createLxBridgeRuntime(spec)` 的**函数体**会被 `.toString()` 原样嵌入
产物，所以它遵守两条硬约束：

- 不 `import` 任何东西、不引用任何模块作用域标识符；
- MD5、AES（ECB/CBC × 128/192/256，PKCS7）、base64、hex、UTF-8 全部在
  函数体内自实现（LK 文本是 UTF-8 → hex；AES 对照 NIST SP 800-38A 向量验证）。

### 4.4 死后端快速失败

已实测失效的脚本内第三方后端（`zrcdy.dpdns.org` / `oiapi.net` /
`api.xcvts.cn`，2026-09 全部超时）会被 `lx.request` 提前剪线，不烧取链预算。

### 4.5 v1 / v2 兼容

- **v2**：`lx.on(lx.EVENT_NAMES.request, handler)` —— 主路径；
- **v1**：顶层 `onRequest(id, option)` 或 `module.exports.onRequest` ——
  执行后用 `;return { onRequest, onEvent }` 把脚本作用域里的入口捞出来，
  id 传 `"lx_MUSIC_URL"`，option 同时给出 `musicInfo` / `type` / `quality`
  三种口径（v1 脚本各写各的）。

---

## 5. 内容安全预检（装不上的提前知道）

宿主对第三方包的内容扫描命中**即拒装**，而拒装反馈出现在用户那侧、作者看不到。
洛雪脚本里出现 `fetch(`、`new XMLHttpRequest` 字面量非常常见——所以打包器在
**产出前**先扫一遍（`src/pack-lint.js`，规则与 `pack_safety.rs` **逐条镜像**），
命中即报：

```
内容安全预检命中 3 处（宿主安装期会据此拒绝第三方包）：
  第 12 行  [调用形态]  fetch(
      理由：全局 fetch 直连（音源包的网络出口只能是 host.request）
```

### 5.1 红线条（RAW：字面子串命中即拒）

| 模式 | 理由 |
|---|---|
| `__TAURI_INTERNALS__` / `__TAURI__` | Tauri IPC（可越出引擎窗口） |
| `ipcRenderer` | Electron IPC 桥 |
| `webkit.messageHandlers` | WKWebView 原生桥 |
| `UTSAndroid` / `io.dcloud` | uni-app x 原生桥/运行时 |
| `WebSocket` / `EventSource` / `sendBeacon` | 绕过宿主网络出口 |
| `new XMLHttpRequest` | 同上 |
| `importScripts` / `new Worker(` / `ServiceWorker` / `serviceWorker` | 后台执行体 |
| `child_process` / `process.binding` | Node/本地文件面 |
| `content://` | Android 内容提供器 |

### 5.2 CALL 形态（`fetch(` / `require(`）

命中需要 `fetch(` 且**前一字符不是标识符或 `.`**——`backend.fetch(x)`（方法
调用）与 `prefetch(x)`（更长标识符）不算，`fetch("…")`、`await fetch(…)`
才算全局调用。算法与 `pack_safety.rs` 的 `find_call_pattern` 一致。

### 5.3 刻意不拦什么

`eval(` / `Function(`：见 [4.1](#41-为什么是-new-function--形参遮蔽而不是构建仓的静态包装)。
这也是本运行时能安全地 `new Function` 装载脚本的前提。

### 5.4 纪律：不绕过，只报告

打包器**只报告不改写**，不会帮你把 `fetch(` 拆成 `fet` + `ch(` 之类骗过扫描。
命中就如实告诉作者：要么改源（网络出口收敛到 `lx.request` / `host.request`），
要么走官方签名包渠道。`--force` 可以产出，但产物仍会被宿主拒装——那是给作者
看真实错误用的，不是分发手段。

---

## 6. 能力边界（诚实声明）

| 能力 | 状态 |
|---|---|
| `musicUrl` 取链 | ✅ |
| `lx.request`（经宿主 `host.request` 出口，含表单/JSON body、超时） | ✅ |
| `lx.utils.crypto.md5` / `aesEncrypt` / random | ✅（AES 已对照 NIST 向量） |
| `lx.utils.buffer`/base64/hex/UTF-8 | ✅ |
| v1 `onRequest` / v2 `lx.on("request")` | ✅ |
| qt↔洛雪平台 id 映射（wyy→wy、qq→tx） | ✅ |
| 未申报平台的提前人话拦截 | ✅（脚本内部 `apis[source]` 天书报错被替换成「不支持该平台」） |
| `lx.currentMusicInfo` | ✅（getter 暴露当前曲目） |
| 死后端剪线 | ✅ |
| `lx.utils.zlib`（inflate/deflate） | ❌ 未实现，调用即抛（deflate 解压器体积不划算） |
| `lx.utils.crypto.rsaEncrypt` | ⚠️ 恒返回空串（只在「配置上报」类路径调用，不在取链主链） |
| 搜索 / 歌词 / 封面 | ❌ meta 包职责，播放包不做 |
| 需要用户在洛雪里填配置的源 | ⚠️ 不经洛雪 UI 配置，脚本内无配置的取链路径可用；依赖配置项的会取链失败（错误文本会明说） |
| 受保护 / 混淆到依赖 `GM_*`、`unsafeWindow` 等环境对象的脚本 | ⚠️ 不在 `lx` 面内，不保证可用 |

其中 `zlib` 与 `rsaEncrypt` 的取舍和构建仓 `schemes/lx-host` 同口径，不是抄漏。

---

## 7. 用法

### 7.1 三步走完（最常用）

```bash
# ① 打包：把洛雪源变成一个可安装的播放包
node scripts/build-lx-pack.mjs "我的洛雪源.js" --id my-lx-source
#   产物 ./my-lx-source.js           ← 也可 pnpm build:lx -- "…" --id …

# ② 安装：客户端「设置 → 音源包」→「安装音源包」→「从本地文件」选这个 .js
#    （装完它自动成为生效的播放包；多包共存时可在「已安装的音源包」里切换/卸载）
# ③ 验证：随便播一首歌，出声即通。不出声时，报错文本就是诊断信息。
```

CLI 完整选项：

```bash
node scripts/build-lx-pack.mjs <洛雪源.js> [--id --name --version-code
  --version-name --line-name --out --force --no-lint --quiet -h]
```

```bash
# 完整：显式 id/版本/线路名，输出到指定目录
node scripts/build-lx-pack.mjs 洛雪音乐源.js \
  --id lx-mysource --name "我的音源" --version-code 2 --version-name "2.0" \
  --line-name "我的音源·直连" --out ./dist

# 内容预检命中时仍要产物看真实错误（产物仍会被宿主拒装）
node scripts/build-lx-pack.mjs 某源.js --force
```

退出码：`0` 成功；`1` 参数/读取/预检失败；`2` 生成失败。报告走 stderr、结果走
stdout。npm 装了本包后还有 `npx qt-build-lx-pack` 绑定。

### 7.2 SDK（`import { buildLxPlayPack } from "qt-sources-sdk/src/build-lx-pack.js"`）

```js
import { buildLxPlayPack, toPackId } from "qt-sources-sdk/src/build-lx-pack.js";

const source = await readFileSync("洛雪音乐源.js", "utf8");
const result = buildLxPlayPack({
  scriptText: source,
  id: toPackId("我的音源") || undefined, // 推不出就交给 @name 头
  versionCode: 1,
  versionName: "1.0",
});
if (!result.ok) {
  // result.report 是预检报告（stderr 那份）；result.error 是一句人话
  process.exit(1);
}
writeFileSync(result.fileName, result.text);
```

`src/lx-runtime.js` 也单独导出 `createLxBridgeRuntime`——想自定义装配（自己写
工厂、自管调用时机）的宿主侧工具可以直接用。

### 7.3 示例

- `examples/lx-demo-source.js`：一个最小可用的洛雪 v2 源（取链 / 平台上报 /
  音质声明），可直接 `node scripts/build-lx-pack.mjs examples/lx-demo-source.js`

---

## 8. 验证闭环

`pnpm test:lx`（`scripts/test-lx-packer.mjs`，62 项断言，无需测试框架）：

1. **预检镜像**：红线命中 / `backend.fetch(`・`prefetch(` 豁免 / 行号 / 不拦
   `eval(` `Function(`；
2. **打包器**：id 规则、保留 id、versionCode、U+2028 转义、`@name` 行尾 `*/`
   不破坏包头（首行可 `JSON.parse`）；
3. **端到端装配**：把产物当脚本求值 → `__qtPlayPackFactory(fakeHost)` →
   用桩 `host.request` 喂假后端 → 断言 `getPlayUrl` 返回
   `{url, source, quality, line:{kind:"lx"}}` 且请求确实走了宿主出口；
4. **v1/v2、平台映射、反调试**：`onRequest` / `module.exports.onRequest` 都被接住；
   `wyy→wy`、`qq→tx` 及恒等平台映射；未申报平台回人话；`process.exit` 被阻断；
   死后端剪线；
5. **算法正确性**：md5 三个已知向量、AES-128-ECB 对照 NIST SP 800-38A F.1.1。

装进真机的最终验证 = 客户端「设置 → 音源包」→「安装音源包」→「从本地文件」安装产物
→ 播放任意歌曲：
能出声音 = 装配链路通。

---

## 9. 与构建仓的关系（维护纪律）

| 项 | 权威在 | 说明 |
|---|---|---|
| 包格式 / 包头解析 / 保留 id | 构建仓 `source_pack_header.rs` | SDK 只镜像常量（`PACK_HEADER_PREFIX` 等） |
| 内容安全红线与算法 | 构建仓宿主 `pack_safety.rs` | SDK `pack-lint.js` **逐条镜像**，改一边必须改另一边 |
| 洛雪桥语义（动作映射/音质/id 别名） | 构建仓 `schemes/lx-host/*` | 本方案是其播放包化的运行时版；差异见 [4.2](#42-修掉的两个构建仓缺陷不是风格差异) |

SDK 侧**不重复实现**任何平台端点、签名算法或线路配置——那些留在构建仓。