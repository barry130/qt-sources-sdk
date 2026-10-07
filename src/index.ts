/**
 * 青听 QuietMusic 音源包 SDK —— 对外入口。
 *
 * 两块拼在一起：
 * - 契约面（contract）：源/音质 id、曲目与各类资源模型、宿主 request 的出入参；
 * - 宿主接面（host-api）：宿主注入什么、包必须挂出什么、返回值的形状。
 *
 * 只含类型与常量，**不含任何平台端点、签名算法或线路配置**——那些留在构建仓。
 */
export * from "./contract";
export * from "./host-api";