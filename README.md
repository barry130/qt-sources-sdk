# qt-sources-sdk

轻听 QuietMusic 音源包的**SDK 面**：宿主注入契约、包格式、类型镜像与作者模板。

面向两类读者：

- **写播放包的作者**——你要实现的全部东西就在这里：[作者指南](docs/PACK-AUTHORING.md)、
  [宿主接面](docs/HOST-API.md)、可直接跑通的[模板](examples/hello-play-pack.js)。
- **想读懂宿主怎么调音源的人**——[契约类型](src/contract.ts)定义了源/音质 id、
  曲目与各类资源模型，以及 `host.request` 的出入参。

## 仓里有什么

```
src/contract.ts        音源访问层契约（类型 + 常量，无任何端点）
src/host-api.ts        宿主注入什么、包必须挂出什么（QtHost / QtPlayPackApi / 包头）
src/index.ts           对外入口
docs/PACK-AUTHORING.md 播放包作者指南（格式、装配、内容安全红线、常见坑）
docs/HOST-API.md       宿主接面与播放包生命周期
examples/hello-play-pack.js  播放包模板（手写、免构建，装上即返回 CC0 演示音频）
```

**没有**什么：任何平台的取链端点、签名算法、线路优先级、官方包产物、构建与签名流水线。
那些在 `qt-sources` 构建仓里，不随本仓分发——理由见 [HOST-API.md §7](docs/HOST-API.md)。

## 快速上手

1. 复制 [`examples/hello-play-pack.js`](examples/hello-play-pack.js) 改 `id`/`name`；
2. 把 `getPlayUrl` 换成你自己的取链：只经 `host.request` 发请求，
   成功 resolve `JSON.stringify({ url, source, quality, line })`，失败 reject 一句
   **人话**错误（它是用户唯一能看到的诊断信息）；
3. 客户端「设置 → 音源包管理」安装该文件，播放任意歌曲；
   能听到演示音频 = 装配链路通了。

## 契约演进

契约发版后**只增不改**：新字段一律可选。否则已按旧契约写好的作者包会在新契约下编不过。
`src/contract.ts` 是构建仓那份的逐字镜像，改动流程：

```bash
# 在 qt-sources 仓里
pnpm check:sdk   # 校验本仓副本与构建仓无漂移
pnpm sync:sdk    # 把契约/指南/示例复制到 SDK 仓
```

构建仓不在同一台机器时 `check:sdk` 会跳过，不阻塞流水线。

## 许可

[MIT](LICENSE)。包内引用的第三方脚本、平台接口与商标归各自权利人所有——本仓不包含它们。