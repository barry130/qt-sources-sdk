/**
 * ═══════════════════════════════════════════════════════════════════════════
 * 镜像声明：本文件是构建仓 `src/contract.ts` 的逐字副本（唯一的真源在构建仓）。
 *
 * 公开面只有类型与常量，没有任何平台端点、签名参数或线路配置，因此可以随本仓
 * 分发。修改流程：改构建仓那份 → 跑构建仓的 `pnpm sync:sdk`（复制）+ `pnpm check:sdk`
 * （校验无漂移）。契约发版后**只增不改**：新字段一律可选，否则已按旧契约写好的
 * 作者包会在新契约下编不过。
 * ═══════════════════════════════════════════════════════════════════════════
 */
/**
 * 音源访问层契约（插件化方案 v3 · 全量版）
 *
 * 本目录是「共享音源脚本包」在 qt-pc 内的落位（未来抽出为 packages/music-sources，
 * 供 qt-uniappx 以 uts 编译直接复用同一份源码）。规则（方案 v3）：
 * - 这里只放"调第三方源"的逻辑：编排、请求参数拼装、响应解析、回退；
 * - 不写任何 HTTP 执行实现 —— 由宿主注入 request builtin
 *   （PC：invoke → Rust reqwest；uniappx 未来：包装 http.ts directRequest）；
 * - 加密模块以"原样文件"搬入本包（kg-md5 / kw-des / kw 鉴权）。
 *
 * 本文件是两端"方法名/模型/出入参完全一致"的唯一真源：
 * uniappx 接入时直接 import 本文件，禁止两端各写一份。
 */

/**
 * 在线音源 id —— **开放字符串，宿主不内置任何枚举**（2026-10 音源包全开放）。
 *
 * 清单的唯一真源是包侧注册表 `registry.ts` 的 `SOURCES`：新增/下线一个在线音源
 * 只改那个文件并重发 meta 包，两端宿主经 `__qtEntries.sourceRegistry()` 动态读取，
 * 不做任何 id 白名单校验（宿主只把它当不透明字符串透传）。
 *
 * 唯一保留值 = `local`（本地曲目）：它由宿主硬编码实现（不进包、不走网络取链），
 * 见 {@link LOCAL_SOURCE}。历史实现把 wyy/qq/kw/kg 写成封闭联合类型，导致
 * 「音源包里声明了新平台、宿主却不认」——该封闭枚举已删除。
 */
export type Source = string;

/**
 * 本地曲目保留 id（**宿主硬编码，不是音源包声明项**）。
 *
 * 语义：曲目 id 是音频文件绝对路径，取链/搜索/歌词一律由宿主本地实现处理，
 * 音源包注册表里不会、也不该出现这个 id。
 */
export const LOCAL_SOURCE = "local";

/**
 * 音质档位 id —— 同样开放字符串。
 *
 * 档位清单的唯一真源是包侧注册表 `QUALITIES`；新增一档（如 "hires"）只需在包里
 * 声明、并让包内线路的 `qualities` / `qualityMap` 覆盖它，宿主侧不再过滤。
 */
export type Quality = string;

/** 曲目：qt-pc Track / qt-uniappx Song 的公共超集（两端各写少量字段映射） */
export interface MusicInfo {
  id: string;
  name: string;
  singer: string;
  album: string;
  picUrl: string;
  /** 秒（两端同口径；蓝本字段名 duration） */
  interval: number;
  musicId?: string | null;
}

/** 歌单（广场卡片；契约模型） */
export interface ContractPlaylist {
  id: string;
  platform: Source;
  name: string;
  picUrl: string;
  playCount: string;
}

/** 歌单详情（含曲目；蓝本 playlist() 返回结构） */
export interface ContractPlaylistDetail extends ContractPlaylist {
  description: string | null;
  tracks: MusicInfo[];
}

/** 歌单广场分类 */
export interface ContractPlaylistCategory {
  id: string;
  name: string;
  group: string | null;
}

/** 歌手 */
export interface ContractArtist {
  id: string;
  platform: Source;
  name: string;
  picUrl: string;
}

/**
 * 歌手详情（v6 契约，2026-10-06 新增）。
 *
 * 各平台能力不齐：酷我/酷狗有真实的详情端点（简介 + 作品数），网易云只有作品计数，
 * QQ 连详情端点都没有 —— 缺的字段一律留空/0（"宁缺勿造"），宿主据此决定是否渲染。
 */
export interface ContractArtistDetail {
  /** 歌手 id，回显入参 */
  id: string;
  platform: Source;
  name: string;
  picUrl: string;
  /** 简介；无则空串 */
  description: string;
  /** 歌曲总数；未知 0 */
  musicNum: number;
  /** 专辑总数；未知 0 */
  albumNum: number;
  /** MV 总数；未知 0 */
  mvNum: number;
  /** 粉丝数；未知 0 */
  fans: number;
}

/**
 * 歌手专辑（v6 契约，2026-10-06 新增）。
 *
 * ContractAlbum 只有 id/platform/name/artist/picUrl，没有发行日期和曲目数；歌手页要展示这两项，
 * 但给旧契约加必填字段会让所有平台模块编译不过，所以另建一个带可选元信息的类型，旧的保持不动。
 */
export interface ContractArtistAlbum {
  id: string;
  platform: Source;
  name: string;
  artist: string;
  picUrl: string;
  /** 发行日期；无则空串 */
  date: string;
  /** 收录曲目数；未知 0 */
  worksNum: number;
}

/** 专辑 */
export interface ContractAlbum {
  id: string;
  platform: Source;
  name: string;
  artist: string;
  picUrl: string;
}

/** 榜单 */
export interface ContractChart {
  id: string;
  platform: Source;
  name: string;
  picUrl: string;
  description: string | null;
}

/**
 * 歌词（原文 + 翻译；qt-pc Lyric 同构）。
 *
 * 2026-10-06 追加两个**可选**面（借鉴 MusicFree 的逐字歌词 + 罗马音）：
 * - `wordByWord`：逐字歌词，统一用 QRC 行内格式 `[行起点ms,行时长ms]词(词起点ms,词时长ms)…`
 *   （词起点是**行内相对值**，与网易 YRC 一致；酷狗 KRC 原始是行内相对，转出来天然一致）。
 *   取不到就是空串——逐字是锦上添花，缺了必须能正常显示普通歌词。
 * - `romanization`：罗马音翻译（日文/韩文歌的假名注音），普通 LRC 格式 `[mm:ss.xxx]…`。
 *
 * 两者都是 `string` 而非 `string | null`，与既有 lyric/translation 一致：
 * 宿主侧判空即可，不用处理 null 分支。
 */
export interface ContractLyric {
  lyric: string;
  translation: string;
  /** 逐字歌词（QRC 行内格式）；无则空串 */
  wordByWord?: string;
  /** 罗马音/注音歌词；无则空串 */
  romanization?: string;
}

// ---------- 宿主内置方法（注入；本期仅 request 一类） ----------

export interface SourceRequestOptions {
  method?: "GET" | "POST";
  /** 按平台伪造 Referer/UA 等（蓝本 makeHeaders 的头由脚本侧拼装） */
  headers?: Record<string, string>;
  body?: string;
  /** 默认 15000ms */
  timeoutMs?: number;
}

export interface SourceResponse {
  statusCode: number;
  /** header 名统一小写；酷我 Cookie 流程依赖 Set-Cookie 透传 */
  headers: Record<string, string>;
  /**
   * 宿主直接尝试按 JSON 解析响应体，失败则原样字符串。
   * 注意不能依赖 content-type 判断：上游普遍回 text/plain、x-javascript
   * 甚至 text/html 却携带 JSON 体（试点实测三平台皆如此，蓝本 http.ts
   * 的 directRequest 同样是无视 content-type 直接解析）。
   */
  body: unknown;
}

export type RequestBuiltin = (
  url: string,
  options?: SourceRequestOptions,
) => Promise<SourceResponse>;

// ---------- 取链方案 ----------

/**
 * "script" = 内置脚本包（默认方案：官方接口 + 全部实测第三方线路的聚合链，
 *            音质高→低、每档 ≤5 条、末级跨源，见 actions/play-url.ts）；
 * 其余 id  = drop-in 方案（schemes/ 下的 scheme.ts 自注册，见 registry.ts），
 *            目前仅 "premium"（优选聚合：脚本包每档 5 条上限放不下的剩余
 *            线路——kw=墨澜 → 独家 v6 → 洛雪，kg=酷狗官方占位；音质高→低、
 *            不跨源）。历史插件（world260809/裤佬/溯音/gdstudio/lx-host 插件
 *            群等）已于 2026-09-17 去重并整体并入脚本包，见
 *            schemes/lx-host/ 与《音源全量复测报告》。
 *
 * 原生 Rust Provider 已整体删除（历史存值 "rust" 读取时归一为 "script"），
 * 第三方音源接口只由脚本层承担。
 *
 * 新增歌源 = schemes/ 下写一个 scheme.ts，无需改任何枚举/校验/路由/UI。
 */
export type BuiltinSchemeId = "script";
export type SchemeId = BuiltinSchemeId | (string & {});
