# 宿主接面（host API）与播放包生命周期

本文是 [《播放包作者指南》](./PACK-AUTHORING.md) 的配套文档：那篇讲「怎么写一个包」，
这篇讲「宿主到底给了你什么、把你的文件怎么装配起来、在哪些地方会被拒」。

类型声明见 [`src/host-api.ts`](../src/host-api.ts) 与 [`src/contract.ts`](../src/contract.ts)，
本文只讲语义与边界。

---

## 1. 两个包，两个信任级别

| | 元数据包（meta-bundle） | 播放音源包（play pack） |
| --- | --- | --- |
| 内容 | 搜索/歌单/专辑/歌手/榜单/热词/歌词/封面 + 可播性预检 | 取链（把曲目变成一条真实可播放的 URL） |
| 分发方式 | **官方在线分发**，经服务端 manifest/直链安装 | 用户手动安装：「设置 → 音源包管理」 |
| 是否含第三方取链端点 | 否 | 官方包含；**第三方包不含**（你写你自己的） |
| 签名 | 官方保留 id `meta-official`，ed25519 | 官方保留 id `play-official` 必须签名；第三方免签 |
| 本仓库 | 官方包本体在 `qt-sources` 构建仓里 | 格式公开，即本 SDK |

所以第三方作者只需要写**播放音源包**。搜索、歌词、封面这些元数据能力由官方元数据包提供，
宿主会先问元数据包，拿不到再走你的包——你不必重复实现数据面。

## 2. 宿主注入什么

```ts
interface QtHost {
  request: RequestBuiltin;          // 唯一的网络出口
  log?: (message: string) => void;  // 日志通道（PC 可见，安卓不落盘）
  platform?: number;                // 1101 安卓 / 1102 iOS / 1103 Windows
}
```

`host.request(url, options)` 的要点：

- `options`：`method`（GET/POST）、`headers`（自己拼 Referer/UA）、`body`（字符串）、
  `timeoutMs`（默认 15000）。**不支持**表单、流、二进制上传。
- 返回 `{ statusCode, headers, body }`：`headers` 名统一小写（酷我 Cookie 流程依赖
  `set-cookie` 透传）；`body` 是宿主**已经尝试按 JSON 解析**的结果，失败则原样字符串。
- 不要依赖 `content-type` 判断是否为 JSON——上游普遍用 `text/plain`、`x-javascript`、
  甚至 `text/html` 携带 JSON 体。

包内**禁止**自己发网络请求（`fetch`、`XMLHttpRequest`、`WebSocket`、`uni.request`、
原生 socket、`java.net.*`、`okhttp` 等）。原因见 §5。

## 3. 包文件长什么样

一个普通脚本（IIFE），**顶层不能有 `import` / `export`**——宿主用
`new Function(code)` 求值，不走模块系统。首行是自述头：

```js
/*__QT_PACK__{"kind":"play","id":"my-pack","name":"我的播放包","versionCode":1,"versionName":"1.0"}*/
```

宿主不执行包体就能读出身份（列表页显示、覆盖判断都靠它）。求值后必须挂出工厂：

```js
globalThis.__qtPlayPackFactory = function (host) {
  return {
    name: "my-pack",
    version: "1.0",
    loadChain: function (chainJson) { return JSON.stringify({ ok: true, lines: 0 }); },
    getPlayUrl: function (args) {
      return Promise.resolve(JSON.stringify({
        url: "https://example.com/audio.mp3",
        source: args.platform,
        quality: args.quality,
        line: null,
      }));
    },
  };
};
```

没挂 `__qtPlayPackFactory` → 宿主报「该文件不是有效的播放音源包（缺少装配入口）」。

可直接跑通的骨架见 [`examples/hello-play-pack.js`](../examples/hello-play-pack.js)
（装上后任何歌都返回同一段 CC0 演示音频，能听到恐龙叫就说明装配成功）。

## 4. 生命周期

1. 宿主读首行 `__QT_PACK__` 头 → 校验 `kind`/`id`/`versionCode`；
2. 官方保留 id 校验 ed25519 签名（第三方包跳过这一步）；
3. **内容安全扫描**（§5）；
4. `new Function(code)` 求值 → 取 `globalThis.__qtPlayPackFactory`；
5. 调用工厂拿到 API，宿主持有当前生效包的引用（多包共存由宿主侧文件管理，
   引擎侧只认最后一次注入）；
6. 播放时宿主调 `getPlayUrl(args)`：成功 resolve JSON 文本，失败 reject；
7. 宿主拿到 URL 后先做 Range 预检（`verifyPlayable`：真实音频、真实时长、
   实测档位），不通过就换下一条线路——**你返回的 quality 应当是实测档位，
   不要原样回显请求档**，否则下载文件会被虚标成 flac；
8. 宿主删除/停用包时调引擎入口 `uninstallPlayPack`；引擎重启同样回到「未安装」状态，
   此时 `getPlayUrl` 按统一口径报错，客户端引导去设置页。

## 5. 拒装红线

安装期对包体做静态扫描，以下特征命中即拒装（**调用形态与字符串字面量都算**）：

- 直连网络的 API：`fetch`、`XMLHttpRequest`、`WebSocket`、`navigator.sendBeacon`、
  原生 HTTP 客户端、`uni.request` 等；
- 宿主桥 / 引擎逃逸：动态 `eval`、`Function` 构造器取宿主对象、读取
  `__qtHost` 之外的全局、反射式取属性；
- 后台执行体：`setInterval`/`Worker`/`eval` 循环、脱离宿主调度的常驻逻辑。

只经 `host.request` 通信、没有上述特征的包天然合规。误判或需要例外，走作者的
issue 讨论，不要试图绕过扫描。

## 6. 与官方包共存

- 元数据包（数据面）是官方在线分发的，宿主只向它要搜索/歌词/封面；你的包只负责取链。
- 播放包可多包共存、一次只生效一个（设置页切换）。切换后宿主会重新注入，
  你的包应保持**幂等装配**：同一文件重复注入不产生残留全局状态。
- 源 id（`wyy` / `qq` / `kw` / `kg` / `bili` / `migu` …）是开放字符串，宿主不内置
  枚举；`local` 是宿主硬编码的本地曲目，不会进你的包。

## 7. 不随本仓分发的部分

本 SDK 只有契约与格式。以下内容在 `qt-sources` 构建仓，不随本仓分发：

- 各平台的真实取链端点、签名/加密算法与线路优先级（逆向实现，涉平台方与第三方
  脚本作者的版权，详见仓库根 `NOTICE.md`）；
- 官方播放包 `play-official` 的产物；
- 构建与签名流水线配置、发布方私钥。

这些不是"暂时没放出来"，而是**明确不分发**：自行实现取链请只对你有权使用的接口
工作，并遵守目标站点的服务条款。