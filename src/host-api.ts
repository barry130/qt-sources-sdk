/**
 * 宿主注入契约（host API）—— 音源包作者唯一需要实现的接面。
 *
 * 这里是构建仓 `src/meta-entries.ts` / `src/play-entries.ts` 里那几段接口声明的
 * **公开镜像**：字段与默认行为逐条对齐，签名相同。构建仓那几段还内嵌了大量实现
 * 侧注释与内部常量（meta 修订号、缺失提示口径等），不在公开面内，所以本文件重写
 * 了注释，只留作者用得到的部分。
 *
 * 版本：HOST_API_VERSION = 1（与 manifest 和两端宿主的 source-engine.uts 同号）。
 * 破坏性变更一律加版本号，旧包按旧版本继续可用。
 */
import type { RequestBuiltin } from "./contract";

/**
 * 宿主注入的能力对象（prelude 注入）。
 *
 * 包内**禁止**自己发网络请求：一律通过 `host.request`，这样才能满足安装期的内容
 * 安全扫描（直连网络的 API 特征、调用形态、字符串字面量都算，命中直接拒装）。
 */
export interface QtHost {
  /**
   * 唯一的网络出口。语义与 PC 的 Rust `builtin_request` 同契约：
   * 响应头名统一小写（酷我 Cookie 流程依赖 Set-Cookie 透传），
   * body 由宿主先尝试按 JSON 解析、失败则原样字符串——
   * **不能依赖 content-type 判断**（上游普遍用 text/plain 携 JSON 体）。
   */
  request: RequestBuiltin;
  /** 宿主日志通道；PC 可见，安卓不落盘。包内排障用它，别用 console。 */
  log?: (message: string) => void;
  /** 宿主平台号：1101 安卓 / 1102 iOS / 1103 Windows；缺省按安卓处理。 */
  platform?: number;
}

/** `host.request` 的签名来自契约面，见 contract.ts 的 RequestBuiltin。 */

/** `getPlayUrl` 的入参（宿主按当前播放曲目映射而来）。 */
export interface QtGetPlayUrlArgs {
  /** 源 id（`local` 是宿主硬编码的本地曲目，不会走到取链）。 */
  platform: string;
  id: string;
  name: string;
  singer: string;
  album?: string;
  /** 音质档位 id；包声明不支持该档时可在包内自行降档。 */
  quality: string;
  /** 秒。 */
  duration?: number;
}

/** 取链命中线路的可选自述；宿主据此在播放页展示「命中线路」。 */
export interface QtPlayUrlHitLine {
  id: string;
  name: string;
  kind?: string;
  targetSong?: string;
}

/** `getPlayUrl` 的成功返回体（JSON 字符串）。字段名即此处的键名。 */
export interface QtPlayUrlResult {
  url: string;
  source: string;
  quality: string;
  line?: QtPlayUrlHitLine | null;
}

/** `loadChain` 的返回体（JSON 字符串）。 */
export interface QtLoadChainResult {
  ok: boolean;
  lines?: number;
  error?: string;
}

/**
 * 播放包装配后交给宿主调用的 API。
 *
 * 入参/出参一律走 JSON 文本：引擎边界只认字符串，宿主不解析你的对象。
 */
export interface QtPlayPackApi {
  /** 播放包自述（显示/诊断用）。 */
  name: string;
  version: string;
  /**
   * 取链。
   * - 成功：resolve JSON 字符串 `{ url, source, quality, line }`；
   * - 失败：reject Error——**错误文本是用户能看到的唯一诊断信息**，
   *   请写清死因（例如「kw 线路 A：签名超时」），不要笼统写「失败」。
   */
  getPlayUrl(args: QtGetPlayUrlArgs): Promise<string>;
  /** 装载链路配置（chain.json 文本）；返回 JSON 文本，配置非法时抛错。 */
  loadChain(chainJson: string): string;
  /** 诊断信息；宿主不透传，装配后自行调试用。 */
  bundleInfo?(): string;
}

/**
 * 播放包产物执行后必须挂出的工厂。
 *
 * 宿主求值你的文件后读 `globalThis.__qtPlayPackFactory`，调用它拿到
 * {@link QtPlayPackApi}；缺了这个挂载，宿主报「该文件不是有效的播放音源包」。
 */
export type QtPlayPackFactory = (host: QtHost) => QtPlayPackApi;

/** 首行 `__QT_PACK__` 自述头的 JSON 形状。 */
export interface QtPackHeader {
  /** 目前只有 "play"（播放音源包）；元数据包由官方在线分发，不接受第三方安装。 */
  kind: "play";
  /** 包 id，全局唯一，英文小写 + 连字符。 */
  id: string;
  /** 显示名。 */
  name: string;
  /** 单调递增的整数版本；宿主用它决定是否需要提示升级。 */
  versionCode: number;
  /** 人读版本串，例如 "1.0"。 */
  versionName: string;
}

/** 官方保留 id：这两个 id 必须带发布方 ed25519 签名才能安装，第三方作者不要用。 */
export const RESERVED_PACK_IDS = ["play-official", "meta-official"] as const;

/** 宿主注入契约的版本号；与两端宿主的 source-engine.uts 同号。 */
export const HOST_API_VERSION = 1;