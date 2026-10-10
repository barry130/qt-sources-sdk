import type { QtHost } from "./host-api";

/** createLxBridgeRuntime 的入参。 */
export interface LxBridgeSpec {
  /** 宿主注入对象（QtHost，见 host-api.ts） */
  host: QtHost;
  /** 洛雪源脚本原文 */
  scriptText: string;
  /** 展示名（缺省取脚本 @name 头，再缺省 "lx-source"） */
  scriptName?: string;
  /** 等 handler 注册的上限（默认 8000ms） */
  initTimeoutMs?: number;
  /** 单次取链的上限（默认 20000ms） */
  callTimeoutMs?: number;
}

/** 脚本头解析结果。 */
export interface LxScriptHeader {
  name: string;
  description: string;
  version: string;
  author: string;
}

/** 取链用的曲目口径（对应契约 MusicInfo 的轻量投影）。 */
export interface LxSong {
  id: string;
  name: string;
  singer: string;
  album?: string;
  picUrl?: string;
  interval?: number;
}

/** 运行时桥：一个接住洛雪源脚本的沙箱。 */
export interface LxBridgeRuntime {
  /** 脚本展示名 */
  scriptName: string;
  /** md5(脚本原文) —— 脚本自检会用 SCRIPT_MD5 比它 */
  scriptMd5: string;
  /** 脚本头解析结果 */
  header: LxScriptHeader;
  /** 等脚本注册取链入口（挂载后自动执行，可提前等好） */
  ensureReady(): Promise<void>;
  /**
   * 取链。成功 resolve 播放地址字符串；失败 reject（错误文本即用户可见诊断）。
   * @param source qt 平台 id（wyy/qq/kg/kw/mg/yt…）——内部会映射成洛雪协议名
   *   （wyy→wy、qq→tx，其余恒等）再交给脚本
   * @param song 曲目（至少要 id/name/singer）
   * @param quality 契约音质（"128"/"320"/"flac"）
   */
  getUrl(source: string, song: LxSong, quality: string): Promise<string>;
  /** init 上报的注册平台（洛雪协议名：wy/tx/kg/kw/mg…） */
  registeredSources(): string[];
  /**
   * 某平台宣称的音质列表（"128k"/"320k"/"flac"/"flac24bit"）。
   * source 传 qt id 或洛雪名都行（内部先做 qt→洛雪映射）。
   */
  claimedQualities(source: string): string[];
  /** 脚本是否已注册取链入口（探测用，不触发初始化） */
  hasHandler(): boolean;
}

/**
 * 创建一个自包含的洛雪运行时桥。
 *
 * 函数体被打包器以 `.toString()` 内嵌进产出的播放包，因此它是**完全自包含**的：
 * 不 import、不引用任何模块作用域标识符。MD5 / AES / base64 / buffer 全部在
 * 函数体内自实现；脚本用 `new Function` + 形参遮蔽执行（含 setTimeout/setInterval
 * 拦截、process.exit 阻断、死后端快速失败、未申报平台的人话拦截）。详见解法 docs/LX-PACKING.md。
 */
export function createLxBridgeRuntime(spec: LxBridgeSpec): LxBridgeRuntime;

/**
 * qt 平台 id → 洛雪协议平台名。
 *
 * 只列**不恒等**的两条（wyy→wy、qq→tx）；其余平台（kg/kw/mg/yt/bili…）两边同名，
 * 映射函数一律 `QT_TO_LX_SOURCE[source] || source`。运行时函数体内有一份同值的
 * 静态表（函数体要 toString() 内嵌进产物，不能引用模块作用域），改这里务必同步改那里。
 */
export const QT_TO_LX_SOURCE: { wyy: string; qq: string };

/** 洛雪协议平台名 → qt 平台 id（同样是「只列不恒等的两条」）。 */
export const LX_TO_QT_SOURCE: { wy: string; tx: string };