/**
 * 内容安全预检的类型面（实现见 pack-lint.js）。
 *
 * 规则表与判定算法是宿主安装期扫描（qt-pc `pack_safety.rs` / uni-appx
 * `pack-safety.uts`）的公开镜像；改一边必须改另一边。
 */

/** 单条命中。line 为 1 起行号；snippet 是命中所在行原文（超长截断）。 */
export interface LintHit {
  pattern: string;
  reason: string;
  line: number;
  kind: "raw" | "call";
  snippet: string;
}

/** RAW 规则：`[模式, 理由]`，纯子串匹配。 */
export const RAW_PATTERNS: [string, string][];

/** CALL 规则：`[模式, 理由]`，`模式(` 且前一字符不是标识符或 `.`。 */
export const CALL_PATTERNS: [string, string][];

/** `c` 是否为标识符字符或 `.`（CALL 形态的前缀豁免）。 */
export function isIdentOrDot(c: string): boolean;

/** 在 text 中查找 CALL 形态的 pattern 的首个下标；无则 -1。 */
export function findCallPattern(text: string, pattern: string): number;

/** 命中下标 → 1 起行号。 */
export function lineOf(text: string, idx: number): number;

/** 扫描包文本，返回全部命中（按行号排序）。 */
export function scanPackText(text: string): LintHit[];

/** 把命中列表渲染成人读报告；无命中时空串。 */
export function formatHits(hits: LintHit[]): string;