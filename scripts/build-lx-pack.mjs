#!/usr/bin/env node
/**
 * 洛雪源 → qt 播放包 命令行打包器。
 *
 * 用法：
 *   node scripts/build-lx-pack.mjs <洛雪源.js> [options]
 *
 * 选项：
 *   --id <id>              包 id（^[a-z0-9-]{2,32}$；缺省由 --name 或脚本 @name 头推导）
 *   --name <名字>          显示名（缺省取脚本 @name 头）
 *   --version-code <n>     单调递增整数版本（缺省 1）
 *   --version-name <串>    人读版本串（缺省取脚本 @version 头）
 *   --line-name <名字>     命中线路展示名（缺省 = 显示名）
 *   --out <路径>           输出文件（缺省 ./<id>.js）
 *   --force                内容预检命中时仍然产出（产物仍会被宿主拒装）
 *   --no-lint              跳过内容预检（调试用，不建议）
 *   --quiet                只输出结果行
 *   -h, --help             看帮助
 *
 * 退出码：0 成功；1 参数/读取/预检失败；2 生成失败。
 *
 * 例：
 *   node scripts/build-lx-pack.mjs 洛雪音乐源.js --id lx-demo --name "洛雪演示" --version-code 1
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, basename, resolve, extname, join } from "node:path";
import { buildLxPlayPack, toPackId } from "../src/build-lx-pack.js";

const HELP = `洛雪源 → qt 播放包 打包器

用法：
  node scripts/build-lx-pack.mjs <洛雪源.js> [options]

选项：
  --id <id>              包 id（^[a-z0-9-]{2,32}$；缺省由 --name 或脚本 @name 头推导）
  --name <名字>          显示名（缺省取脚本 @name 头）
  --version-code <n>     单调递增整数版本（缺省 1）
  --version-name <串>    人读版本串（缺省取脚本 @version 头）
  --line-name <名字>     命中线路展示名（缺省 = 显示名）
  --out <路径>           输出文件（缺省 ./<id>.js）
  --force                内容预检命中时仍然产出（产物仍会被宿主拒装）
  --no-lint              跳过内容预检（调试用，不建议）
  --quiet                只输出结果行
  -h, --help             看帮助

退出码：0 成功；1 参数/读取/预检失败；2 生成失败。
`;

/** 取值型选项 → 结构字段 */
const VALUE_OPTS = {
  "--id": "id",
  "--name": "name",
  "--version-code": "versionCode",
  "--version-name": "versionName",
  "--line-name": "lineName",
  "--out": "out",
};

function fail(message) {
  process.stderr.write(`错误：${message}\n`);
  process.exit(1);
}

function main(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || args.includes("-h") || args.includes("--help")) {
    process.stdout.write(HELP);
    process.exit(args.length === 0 ? 1 : 0);
  }

  const opts = { force: false, skipLint: false, quiet: false };
  const positional = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--force") {
      opts.force = true;
    } else if (a === "--no-lint") {
      opts.skipLint = true;
    } else if (a === "--quiet") {
      opts.quiet = true;
    } else if (Object.prototype.hasOwnProperty.call(VALUE_OPTS, a)) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) fail(`${a} 缺少取值`);
      opts[VALUE_OPTS[a]] = value;
      i++;
    } else if (a.startsWith("--")) {
      fail(`未知选项 ${a}（用 --help 看用法）`);
    } else {
      positional.push(a);
    }
  }

  if (positional.length === 0) fail("缺少输入文件（洛雪源 .js 路径）");
  if (positional.length > 1) fail(`只接受一个输入文件，收到 ${positional.length} 个`);

  const inputPath = resolve(positional[0]);
  let scriptText;
  try {
    scriptText = readFileSync(inputPath, "utf8");
  } catch (err) {
    fail(`读不到输入文件 ${inputPath}：${err && err.message ? err.message : String(err)}`);
  }

  const versionCode = opts.versionCode === undefined ? 1 : Number(opts.versionCode);
  const result = buildLxPlayPack({
    scriptText,
    id: opts.id,
    name: opts.name,
    versionCode,
    versionName: opts.versionName,
    lineName: opts.lineName,
    force: opts.force,
    skipLint: opts.skipLint,
  });

  if (result.report) {
    process.stderr.write(result.report + "\n");
  }

  if (!result.ok) {
    fail(result.error);
  }

  // 输出路径：显式 --out 优先，否则与输入同目录的 <id>.js
  let outPath;
  if (opts.out) {
    outPath = resolve(opts.out);
    if (extname(outPath) === "") outPath = join(outPath, result.fileName);
  } else {
    outPath = join(dirname(inputPath), result.fileName);
  }

  try {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, result.text, "utf8");
  } catch (err) {
    process.stderr.write(`生成失败：${err && err.message ? err.message : String(err)}\n`);
    process.exit(2);
  }

  const sizeKb = (Buffer.byteLength(result.text, "utf8") / 1024).toFixed(1);
  if (opts.quiet) {
    process.stdout.write(outPath + "\n");
  } else {
    const headerLine = result.text.slice(0, result.text.indexOf("\n"));
    process.stdout.write(
      [
        `已生成播放包：${outPath}`,
        `  大小      ${sizeKb} KB（源脚本 ${(Buffer.byteLength(scriptText, "utf8") / 1024).toFixed(1)} KB）`,
        `  包头      ${headerLine}`,
        `  预检      ${result.lint.length === 0 ? "通过（无命中）" : `命中 ${result.lint.length} 处（已 --force 放行）`}`,
        "",
        "安装：客户端「设置 → 音源包」→「安装音源包」→「从本地文件」选它。",
        "",
      ].join("\n"),
    );
  }
}

main(process.argv);
