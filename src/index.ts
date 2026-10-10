/**
 * 轻听 QuietMusic 音源包 SDK —— 对外入口。
 *
 * 三块拼在一起：
 * - 契约面（contract）：源/音质 id、曲目与各类资源模型、宿主 request 的出入参；
 * - 宿主接面（host-api）：宿主注入什么、包必须挂出什么、返回值的形状；
 * - 洛雪工具面（lx-runtime / pack-lint / build-lx-pack）：把洛雪音乐自定义源
 *   打包成 qt 播放包的自包含运行时 + 内容安全预检 + 打包函数。
 *
 * 契约面只含类型与常量，**不含任何平台端点、签名算法或线路配置**——那些留在构建仓。
 * 洛雪工具面是纯 JS 实现，类型见同名 `.d.ts`。
 */
export * from "./contract";
export * from "./host-api";
export * from "./lx-runtime";
export * from "./pack-lint";
export * from "./build-lx-pack";