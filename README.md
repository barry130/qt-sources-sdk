# qt-sources-sdk

轻听 QuietMusic 音源包的**SDK 面**：宿主注入契约、包格式、类型镜像与作者模板，
外加**洛雪（LX Music）自定义源 → 播放包**的打包器与命令行工具。

面向三类读者：

- **写播放包的作者**——你要实现的全部东西就在这里：[作者指南](docs/PACK-AUTHORING.md)、
  [宿主接面](docs/HOST-API.md)、可直接跑通的[模板](examples/hello-play-pack.js)。
- **想把洛雪音乐自定义源拿进来用的人**——[洛雪打包方案](docs/LX-PACKING.md)：
  一条命令把源脚本变成可安装的播放包，含内容安全预检（装不上的提前知道）。
- **想读懂宿主怎么调音源的人**——[契约类型](src/contract.ts)定义了源/音质 id、
  曲目与各类资源模型，以及 `host.request` 的出入参。

## 仓里有什么

```
src/contract.ts        音源访问层契约（类型 + 常量，无任何端点）
src/host-api.ts        宿主注入什么、包必须挂出什么（QtHost / QtPlayPackApi / 包头）
src/lx-runtime.js      洛雪运行时桥（自包含：MD5/AES/base64 + lx mock + 沙箱执行）
src/pack-lint.js       内容安全预检（宿主 pack_safety.rs 规则的公开镜像）
src/build-lx-pack.js   洛雪源 → 播放包打包器
src/index.ts           对外入口
docs/PACK-AUTHORING.md 播放包作者指南（格式、装配、内容安全红线、常见坑）
docs/HOST-API.md       宿主接面与播放包生命周期
docs/LX-PACKING.md     洛雪源打包方案（动作映射、运行时桥设计、能力边界、CLI 用法）
examples/hello-play-pack.js  播放包模板（手写、免构建，装上即返回 CC0 演示音频）
examples/lx-demo-source.js   洛雪源示例（配合打包器跑通全链路）
scripts/build-lx-pack.mjs    命令行打包器：node scripts/build-lx-pack.mjs <洛雪源.js>
scripts/test-lx-packer.mjs   打包器自测（pnpm test:lx，62 项断言，无需框架）
```

**没有**什么：任何平台的取链端点、签名算法、线路优先级、官方包产物、构建与签名流水线。
那些在 `qt-sources` 构建仓里，不随本仓分发——理由见 [HOST-API.md §7](docs/HOST-API.md)。

## 快速上手

**手写播放包：**

1. 复制 [`examples/hello-play-pack.js`](examples/hello-play-pack.js) 改 `id`/`name`；
2. 把 `getPlayUrl` 换成你自己的取链：只经 `host.request` 发请求，
   成功 resolve `JSON.stringify({ url, source, quality, line })`，失败 reject 一句
   **人话**错误（它是用户唯一能看到的诊断信息）；
3. 客户端「设置 → 音源包」→「安装音源包」→「从本地文件」选该文件，播放任意歌曲；
   能听到演示音频 = 装配链路通了。

**把洛雪源打包成播放包（三步）：**

```bash
# ① 打包
node scripts/build-lx-pack.mjs "洛雪音乐源.js" --id my-lx-source
#   产物 ./my-lx-source.js   （也可 pnpm build:lx -- "…" --id …）

# ② 安装：客户端「设置 → 音源包」→「安装音源包」→「从本地文件」选它
# ③ 播放任意歌曲验证：出声即通
```

完整选项、能力边界（搜索/歌词不做、zlib 不实现等）与运行时桥设计见
[洛雪打包方案](docs/LX-PACKING.md)。

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