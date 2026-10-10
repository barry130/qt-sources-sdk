import type { LintHit } from "./pack-lint";

/** buildLxPlayPack 的入参。 */
export interface BuildLxPackOptions {
  /** 洛雪源脚本原文（必填） */
  scriptText: string;
  /** 包 id（必填或可由 name 推导；规则 ^[a-z0-9-]{2,32}$） */
  id?: string;
  /** 显示名（缺省取脚本 @name 头） */
  name?: string;
  /** 单调递增整数版本（默认 1） */
  versionCode?: number;
  /** 人读版本串（缺省取脚本 @version 头或 versionCode 字符串） */
  versionName?: string;
  /** 作者（仅写进产物注释，不进包头） */
  author?: string;
  /** 命中线路展示名（缺省 = 显示名） */
  lineName?: string;
  /** 建议文件名（缺省 `<id>.js`） */
  outFileName?: string;
  /** 预检命中时是否仍然产出（默认 false；产物仍会被宿主拒装） */
  force?: boolean;
  /** 跳过预检（不推荐，仅调试用） */
  skipLint?: boolean;
}

/** buildLxPlayPack 的结果。 */
export interface BuildLxPackResult {
  ok: boolean;
  /** 建议文件名（默认 `<id>.js`） */
  fileName: string;
  /** 播放包全文 */
  text: string;
  /** 内容预检命中（有命中时，行号对**源脚本**坐标，方便作者定位） */
  lint: LintHit[];
  /** 预检报告（无命中时空串） */
  report: string;
  /** ok=false 时的错误文本（人话） */
  error?: string;
}

/**
 * 打包一份洛雪源为 qt 播放包（单文件、免构建、可直接安装）。
 *
 * 结构：首行包头 `/*__QT_PACK__{…}*​/` → 洛雪运行时（内嵌）→ 源脚本原文（内嵌）
 * → `globalThis.__qtPlayPackFactory(host)`。只承担取链（musicUrl 动作）。
 */
export function buildLxPlayPack(options: BuildLxPackOptions): BuildLxPackResult;

/** 把任意显示名转成合法包 id（小写、非 [a-z0-9-] 换连字符、截 32 位）；推不出返回 ""。 */
export function toPackId(text: string): string;

/** 包头前缀（与宿主 source_pack_header.rs:21 同步）。 */
export const PACK_HEADER_PREFIX: string;

/** 包 id 规则（与宿主 source_pack_header.rs:36-42 的 valid_pack_id 同步）。 */
export const PACK_ID_RE: RegExp;

/** 官方保留 id：必须带发布方 ed25519 签名才能安装。 */
export const RESERVED_PACK_IDS: string[];