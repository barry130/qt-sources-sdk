/**
 * 洛雪（LX Music）自定义源 → qt 播放包 的**运行时桥**（自包含，无任何 import）。
 *
 * ## 这个文件为什么长这样
 *
 * `build-lx-pack.js` 用 `createLxBridgeRuntime.toString()` 把本函数**原样文本**嵌进
 * 产出的播放包。所以：
 *
 * 1. 本函数内部**不得引用任何模块作用域标识符**（外部常量、import 进来的东西统统不行），
 *    否则打包出来的包在别人机器上抛 `xxx is not defined`；
 * 2. 本文件**不 import 任何东西**，连类型都不引（类型注解会被 toString 带出去，且
 *    抹掉注解是打包器的责任——保持纯 JS 最省事）；
 * 3. 因此所有工具（MD5 / AES / base64 / buffer）都在函数体内自己实现一遍。
 *    构建仓 `qt-sources/src/schemes/lx-host/crypto.ts` 那套是 TS + 模块导入，嵌不进来。
 *
 * ## 与构建仓方案的差异（有意为之，不是抄漏）
 *
 * 构建仓的 `gen-lx-vendor.mjs` 在**构建期**生成静态包装：
 * `(function (globalThis, process, lx, SCRIPT_MD5, console, window) { <脚本原文> })(...)`。
 * 它必须这么做，因为引擎页 CSP 禁 `eval` / `new Function`。
 *
 * 本 SDK 的包由**作者的机器**打包、在引擎窗口里执行，而引擎窗口的内容扫描
 * （`qt-pc/src-tauri/src/pack_safety.rs:17-22`）**刻意不拦 `eval(` / `Function(`**：
 * crypto-js 的 `Function("return this")()` 探测是内联加密库标配，拦了会误杀主流第三方包。
 * 所以这里可以在运行时用 `new Function` 达到与静态包装完全一致的效果。
 *
 * 两处**修掉了构建仓的缺陷**（不是风格差异）：
 * - `setTimeout` / `setInterval` 做成**形参**。构建仓把它们放在 globalThis Proxy 的
 *   overrides 表里，但裸标识符 `setTimeout` 根本不走 Proxy（词法上直接落真实全局），
 *   那条防护实际是空的；只有形参才拦得住混淆脚本的定时器反调试回调。
 * - 额外遮蔽 `Buffer` / `require` / `module` / `exports`，把 Node 方言的脚本也接住。
 *
 * ## 协议支持面
 *
 * - LX v2：`lx.on(lx.EVENT_NAMES.request, handler)`，handler 收
 *   `{ action, source, info: { musicInfo, type } }`；
 * - LX v1：顶层 `onRequest(id, option)` 或 `module.exports.onRequest`，id 取
 *   `"lx_MUSIC_URL"` / `"musicUrl"`，option 同时给出 `musicInfo`、`musicInfo.type`
 *   与 `quality` 三种口径（v1 脚本各写各的，能兼容的都兼容上）。
 *
 * ## 已知能力边界（诚实声明，别假装支持）
 *
 * - `lx.utils.zlib` 未实现（需要 deflate 解压器，体积不划算），调用即抛错；
 * - `lx.utils.crypto.rsaEncrypt` 恒返回空串（与构建仓同口径：只有「配置上报」类
 *   路径会调它，不在取链主链上）；
 * - `lx.request` 的响应体由宿主先尝试 JSON 解析（契约如此），脚本若依赖**原始文本**
 *   会在个别接口上拿到对象——与构建仓行为一致。
 */

/**
 * 创建一个自包含的洛雪运行时工厂。
 *
 * 说明：本函数体是「被嵌入产物」的那段文本，所以它只依赖**入参**与语言内建能力。
 *
 * @param {object} spec
 * @param {object} spec.host           宿主注入对象（QtHost，见 host-api.ts）
 * @param {string} spec.scriptText     洛雪源脚本原文
 * @param {string} [spec.scriptName]   展示名（缺省用脚本 @name 头，再缺省 "lx-source"）
 * @param {number} [spec.initTimeoutMs=8000]  等 handler 注册的上限
 * @param {number} [spec.callTimeoutMs=20000] 单次取链的上限
 * @returns {object} 运行时桥
 */
export function createLxBridgeRuntime(spec) {
  "use strict";

  var host = spec.host;
  var scriptText = String(spec.scriptText == null ? "" : spec.scriptText);
  var initTimeoutMs = Number(spec.initTimeoutMs) > 0 ? Number(spec.initTimeoutMs) : 8000;
  var callTimeoutMs = Number(spec.callTimeoutMs) > 0 ? Number(spec.callTimeoutMs) : 20000;

  /** 已实测失效的脚本内第三方后端：快速失败，别烧掉取链预算（2026-09 全部超时） */
  var DEAD_BACKEND_HOSTS = ["zrcdy.dpdns.org", "oiapi.net", "api.xcvts.cn"];

  function deadBackendOf(url) {
    var lower = String(url).toLowerCase();
    for (var i = 0; i < DEAD_BACKEND_HOSTS.length; i++) {
      if (lower.indexOf(DEAD_BACKEND_HOSTS[i]) >= 0) return DEAD_BACKEND_HOSTS[i];
    }
    return null;
  }

  function log(message) {
    if (host && typeof host.log === "function") {
      try {
        host.log("[lx] " + message);
      } catch (e) {
        /* 宿主日志通道异常不能影响取链 */
      }
    }
  }

  // ───────────────────────────── MD5（UTF-8 → hex） ─────────────────────────────
  // 构建仓复用 platforms/kg-md5；SDK 必须自包含，这里写标准 RFC 1321 实现。
  // 用途：lx.utils.crypto.md5 + SCRIPT_MD5（脚本零宽字符完整性自检会比对它）。

  function utf8BytesOf(text) {
    var s = String(text);
    if (typeof TextEncoder === "function") return new TextEncoder().encode(s);
    var out = [];
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
        var c2 = s.charCodeAt(i + 1);
        if (c2 >= 0xdc00 && c2 <= 0xdfff) {
          var cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
          out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
          i++;
        } else {
          out.push(0xef, 0xbf, 0xbd);
        }
      } else if (c >= 0xdc00 && c <= 0xdfff) {
        out.push(0xef, 0xbf, 0xbd);
      } else {
        out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      }
    }
    return new Uint8Array(out);
  }

  function md5Hex(input) {
    var msg = typeof input === "string" || input == null ? utf8BytesOf(input == null ? "" : input) : input;
    if (msg instanceof ArrayBuffer) msg = new Uint8Array(msg);
    var len = msg.length;

    // 补位：0x80 + 0x00… 直到长度 ≡ 56 (mod 64)，再补 8 字节小端位长
    var padTo = Math.ceil((len + 9) / 64) * 64;
    var buf = new Uint8Array(padTo);
    buf.set(msg, 0);
    buf[len] = 0x80;

    var view = new DataView(buf.buffer);
    view.setUint32(padTo - 8, (len << 3) >>> 0, true);
    view.setUint32(padTo - 4, Math.floor(len / 536870912) >>> 0, true);

    // K[i] = floor(abs(sin(i+1)) * 2^32)（标准常量表，这里程序化生成，省 256 个字符）
    var K = new Uint32Array(64);
    for (var i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;

    var S = [
      7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
      5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
      4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
      6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
    ];

    function rotl(x, n) {
      return ((x << n) | (x >>> (32 - n))) >>> 0;
    }

    var a0 = 0x67452301;
    var b0 = 0xefcdab89;
    var c0 = 0x98badcfe;
    var d0 = 0x10325476;
    var M = new Uint32Array(16);

    for (var off = 0; off < padTo; off += 64) {
      for (var j = 0; j < 16; j++) M[j] = view.getUint32(off + j * 4, true);
      var A = a0;
      var B = b0;
      var C = c0;
      var D = d0;
      for (var r = 0; r < 64; r++) {
        var F;
        var g;
        if (r < 16) {
          F = (B & C) | (~B & D);
          g = r;
        } else if (r < 32) {
          F = (D & B) | (~D & C);
          g = (5 * r + 1) % 16;
        } else if (r < 48) {
          F = B ^ C ^ D;
          g = (3 * r + 5) % 16;
        } else {
          F = C ^ (B | ~D);
          g = (7 * r) % 16;
        }
        F = (F + A + K[r] + M[g]) >>> 0;
        A = D;
        D = C;
        C = B;
        B = (B + rotl(F, S[r])) >>> 0;
      }
      a0 = (a0 + A) >>> 0;
      b0 = (b0 + B) >>> 0;
      c0 = (c0 + C) >>> 0;
      d0 = (d0 + D) >>> 0;
    }

    function le(x) {
      return (
        String.fromCharCode(x & 0xff, (x >>> 8) & 0xff, (x >>> 16) & 0xff, (x >>> 24) & 0xff)
      );
    }
    var bytes = le(a0) + le(b0) + le(c0) + le(d0);
    var out = "";
    for (var k = 0; k < bytes.length; k++) {
      out += ("0" + bytes.charCodeAt(k).toString(16)).slice(-2);
    }
    return out;
  }

  // ───────────────────────────── AES（ECB/CBC × 128/192/256） ─────────────────────────────

  var SBOX = Uint8Array.from([
    0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76,
    0xca, 0x82, 0xc9, 0x7d, 0xfa, 0x59, 0x47, 0xf0, 0xad, 0xd4, 0xa2, 0xaf, 0x9c, 0xa4, 0x72, 0xc0,
    0xb7, 0xfd, 0x93, 0x26, 0x36, 0x3f, 0xf7, 0xcc, 0x34, 0xa5, 0xe5, 0xf1, 0x71, 0xd8, 0x31, 0x15,
    0x04, 0xc7, 0x23, 0xc3, 0x18, 0x96, 0x05, 0x9a, 0x07, 0x12, 0x80, 0xe2, 0xeb, 0x27, 0xb2, 0x75,
    0x09, 0x83, 0x2c, 0x1a, 0x1b, 0x6e, 0x5a, 0xa0, 0x52, 0x3b, 0xd6, 0xb3, 0x29, 0xe3, 0x2f, 0x84,
    0x53, 0xd1, 0x00, 0xed, 0x20, 0xfc, 0xb1, 0x5b, 0x6a, 0xcb, 0xbe, 0x39, 0x4a, 0x4c, 0x58, 0xcf,
    0xd0, 0xef, 0xaa, 0xfb, 0x43, 0x4d, 0x33, 0x85, 0x45, 0xf9, 0x02, 0x7f, 0x50, 0x3c, 0x9f, 0xa8,
    0x51, 0xa3, 0x40, 0x8f, 0x92, 0x9d, 0x38, 0xf5, 0xbc, 0xb6, 0xda, 0x21, 0x10, 0xff, 0xf3, 0xd2,
    0xcd, 0x0c, 0x13, 0xec, 0x5f, 0x97, 0x44, 0x17, 0xc4, 0xa7, 0x7e, 0x3d, 0x64, 0x5d, 0x19, 0x73,
    0x60, 0x81, 0x4f, 0xdc, 0x22, 0x2a, 0x90, 0x88, 0x46, 0xee, 0xb8, 0x14, 0xde, 0x5e, 0x0b, 0xdb,
    0xe0, 0x32, 0x3a, 0x0a, 0x49, 0x06, 0x24, 0x5c, 0xc2, 0xd3, 0xac, 0x62, 0x91, 0x95, 0xe4, 0x79,
    0xe7, 0xc8, 0x37, 0x6d, 0x8d, 0xd5, 0x4e, 0xa9, 0x6c, 0x56, 0xf4, 0xea, 0x65, 0x7a, 0xae, 0x08,
    0xba, 0x78, 0x25, 0x2e, 0x1c, 0xa6, 0xb4, 0xc6, 0xe8, 0xdd, 0x74, 0x1f, 0x4b, 0xbd, 0x8b, 0x8a,
    0x70, 0x3e, 0xb5, 0x66, 0x48, 0x03, 0xf6, 0x0e, 0x61, 0x35, 0x57, 0xb9, 0x86, 0xc1, 0x1d, 0x9e,
    0xe1, 0xf8, 0x98, 0x11, 0x69, 0xd9, 0x8e, 0x94, 0x9b, 0x1e, 0x87, 0xe9, 0xce, 0x55, 0x28, 0xdf,
    0x8c, 0xa1, 0x89, 0x0d, 0xbf, 0xe6, 0x42, 0x68, 0x41, 0x99, 0x2d, 0x0f, 0xb0, 0x54, 0xbb, 0x16,
  ]);

  function xtime(a) {
    return ((a << 1) ^ (a & 0x80 ? 0x1b : 0)) & 0xff;
  }

  function expandKey(key) {
    var nk = key.length / 4;
    var nr = nk + 6;
    var wordCount = 4 * (nr + 1);
    var words = [];
    for (var i = 0; i < nk; i++) words.push(key.slice(i * 4, i * 4 + 4));
    var rcon = 1;
    for (var w = nk; w < wordCount; w++) {
      var temp = words[w - 1].slice();
      if (w % nk === 0) {
        temp = Uint8Array.from([SBOX[temp[1]], SBOX[temp[2]], SBOX[temp[3]], SBOX[temp[0]]]);
        temp[0] ^= rcon;
        rcon = xtime(rcon);
      } else if (nk > 6 && w % nk === 4) {
        temp = Uint8Array.from(temp, function (b) {
          return SBOX[b];
        });
      }
      var prev = words[w - nk];
      var mixed = new Uint8Array(4);
      for (var q = 0; q < 4; q++) mixed[q] = temp[q] ^ prev[q];
      words.push(mixed);
    }
    var roundKeys = [];
    for (var r = 0; r <= nr; r++) {
      var rk = new Uint8Array(16);
      for (var c = 0; c < 4; c++) rk.set(words[r * 4 + c], c * 4);
      roundKeys.push(rk);
    }
    return roundKeys;
  }

  function encryptBlock(block, roundKeys, out) {
    var state = new Uint8Array(16);
    for (var i = 0; i < 16; i++) state[i] = block[i] ^ roundKeys[0][i];
    var nr = roundKeys.length - 1;

    for (var round = 1; round <= nr; round++) {
      var t = new Uint8Array(16);
      for (var b = 0; b < 16; b++) t[b] = SBOX[state[b]];
      // ShiftRows（列主序：字节下标 = 4*col + row）
      var s = new Uint8Array(16);
      for (var col = 0; col < 4; col++) {
        for (var row = 0; row < 4; row++) {
          s[4 * col + row] = t[4 * ((col + row) % 4) + row];
        }
      }
      if (round !== nr) {
        var m = new Uint8Array(16);
        for (var cc = 0; cc < 4; cc++) {
          var a0 = s[4 * cc];
          var a1 = s[4 * cc + 1];
          var a2 = s[4 * cc + 2];
          var a3 = s[4 * cc + 3];
          var all = a0 ^ a1 ^ a2 ^ a3;
          m[4 * cc] = a0 ^ all ^ xtime(a0 ^ a1);
          m[4 * cc + 1] = a1 ^ all ^ xtime(a1 ^ a2);
          m[4 * cc + 2] = a2 ^ all ^ xtime(a2 ^ a3);
          m[4 * cc + 3] = a3 ^ all ^ xtime(a3 ^ a0);
        }
        s = m;
      }
      for (var x = 0; x < 16; x++) state[x] = s[x] ^ roundKeys[round][x];
    }
    for (var y = 0; y < 16; y++) out[y] = state[y];
    return out;
  }

  function pkcs7Pad(buf) {
    var pad = 16 - (buf.length % 16);
    var out = new Uint8Array(buf.length + pad);
    out.set(buf, 0);
    for (var i = buf.length; i < out.length; i++) out[i] = pad;
    return out;
  }

  /**
   * AES 加密，返回 Uint8Array（脚本侧通常再 bufToString(…, "hex")）。
   * mode 接受 "aes-128-ecb" / "AES-192-CBC" 这类写法（大小写不敏感）。
   */
  function aesEncrypt(data, mode, key, iv) {
    var m = String(mode || "aes-128-ecb").toLowerCase();
    var ecb = m.indexOf("ecb") >= 0;
    var keyBytes = typeof key === "string" ? utf8BytesOf(key) : toBytes(key);
    if (keyBytes.length !== 16 && keyBytes.length !== 24 && keyBytes.length !== 32) {
      throw new Error("aesEncrypt: 密钥长度必须是 16/24/32 字节，收到 " + keyBytes.length);
    }
    var input = typeof data === "string" ? utf8BytesOf(data) : toBytes(data);
    var padded = pkcs7Pad(input);
    var roundKeys = expandKey(keyBytes);
    var out = new Uint8Array(padded.length);

    if (ecb) {
      for (var off = 0; off < padded.length; off += 16) {
        encryptBlock(padded.subarray(off, off + 16), roundKeys, out.subarray(off, off + 16));
      }
      return out;
    }

    var ivBytes = iv == null ? new Uint8Array(16) : typeof iv === "string" ? utf8BytesOf(iv) : toBytes(iv);
    if (ivBytes.length !== 16) throw new Error("aesEncrypt: CBC 的 iv 必须是 16 字节");
    var prev = ivBytes;
    for (var o = 0; o < padded.length; o += 16) {
      var blk = new Uint8Array(16);
      for (var i = 0; i < 16; i++) blk[i] = padded[o + i] ^ prev[i];
      var enc = encryptBlock(blk, roundKeys, new Uint8Array(16));
      out.set(enc, o);
      prev = enc;
    }
    return out;
  }

  // ───────────────────────────── buffer / base64 ─────────────────────────────

  function toBytes(v) {
    if (v == null) return new Uint8Array(0);
    if (v instanceof Uint8Array) return v;
    if (v instanceof ArrayBuffer) return new Uint8Array(v);
    if (Array.isArray(v)) return Uint8Array.from(v);
    if (v.buffer instanceof ArrayBuffer) return new Uint8Array(v.buffer, v.byteOffset || 0, v.byteLength);
    return utf8BytesOf(String(v));
  }

  var B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

  function base64Encode(bytes) {
    var out = "";
    for (var i = 0; i < bytes.length; i += 3) {
      var b0 = bytes[i];
      var has1 = i + 1 < bytes.length;
      var has2 = i + 2 < bytes.length;
      var b1 = has1 ? bytes[i + 1] : 0;
      var b2 = has2 ? bytes[i + 2] : 0;
      out += B64_CHARS[b0 >> 2];
      out += B64_CHARS[((b0 & 3) << 4) | (b1 >> 4)];
      out += has1 ? B64_CHARS[((b1 & 15) << 2) | (b2 >> 6)] : "=";
      out += has2 ? B64_CHARS[b2 & 63] : "=";
    }
    return out;
  }

  function base64Decode(text) {
    var s = String(text).replace(/[^A-Za-z0-9+/]/g, "");
    var out = [];
    for (var i = 0; i < s.length; i += 4) {
      var c0 = B64_CHARS.indexOf(s[i]);
      var c1 = B64_CHARS.indexOf(s[i + 1]);
      var c2 = s[i + 2] === undefined ? -1 : B64_CHARS.indexOf(s[i + 2]);
      var c3 = s[i + 3] === undefined ? -1 : B64_CHARS.indexOf(s[i + 3]);
      out.push(((c0 << 2) | (c1 >> 4)) & 0xff);
      if (c2 >= 0) out.push(((c1 & 15) << 4) | (c2 >> 2));
      if (c3 >= 0) out.push(((c2 & 3) << 6) | c3);
    }
    return new Uint8Array(out);
  }

  function bytesToHex(bytes) {
    var out = "";
    for (var i = 0; i < bytes.length; i++) out += ("0" + bytes[i].toString(16)).slice(-2);
    return out;
  }

  function hexToBytes(text) {
    var s = String(text).replace(/[^0-9a-fA-F]/g, "");
    var out = new Uint8Array(Math.floor(s.length / 2));
    for (var i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
    return out;
  }

  /** LX 协议的 utils.buffer.from：字符串按 utf8 编码，其余原样转字节 */
  function bufferFrom(v) {
    return typeof v === "string" ? utf8BytesOf(v) : toBytes(v);
  }

  /** LX 协议的 utils.buffer.bufToString：utf8 | hex | base64 */
  function bufferToString(buf, encoding) {
    var bytes = toBytes(buf);
    var enc = String(encoding || "utf8").toLowerCase();
    if (enc === "hex") return bytesToHex(bytes);
    if (enc === "base64") return base64Encode(bytes);
    if (typeof TextDecoder === "function") return new TextDecoder().decode(bytes);
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }

  /** Node 方言的 Buffer 桩（脚本里 Buffer.from / toString("hex") 很常见） */
  function asNodeBuffer(bytes) {
    var b = bytes;
    if (!(b instanceof Uint8Array)) b = toBytes(bytes);
    try {
      Object.defineProperty(b, "toString", {
        value: function (encoding) {
          return bufferToString(b, encoding);
        },
        enumerable: false,
      });
    } catch (e) {
      /* 冻结对象等极端情况：退化为无 toString 的 Uint8Array */
    }
    return b;
  }

  function randomBytes(n) {
    var arr = new Uint8Array(Number(n) || 0);
    var c = typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
    if (c && typeof c.getRandomValues === "function") {
      c.getRandomValues(arr);
    } else {
      for (var i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256);
    }
    return arr;
  }

  // ───────────────────────────── 脚本头解析 ─────────────────────────────

  function parseHeader(raw) {
    // 抓到下一个 `@指令`（或行尾）为止，再裁掉可能残留的注释收尾符
    function strip(s) {
      return String(s).trim().replace(/\s*\*\/?\s*$/, "");
    }
    function grab(re) {
      var m = String(raw).match(re);
      return m && m[1] ? strip(m[1]) : "";
    }
    return {
      name: grab(/@name\s+([^@\n]+)/),
      description: grab(/@description\s+([^@\n]+)/),
      version: grab(/@version\s+([^@\n]+)/),
      author: grab(/@author\s+([^@\n]+)/),
    };
  }

  var header = parseHeader(scriptText);
  var scriptName = String(spec.scriptName || header.name || "lx-source");
  var scriptMd5 = md5Hex(scriptText);

  // ───────────────────────────── 平台 id 映射 ─────────────────────────────
  // qt 侧平台 id（wyy=网易云 / qq=QQ 音乐 / kg / kw / mg / yt…）与洛雪协议名
  // （wy / tx / kg / kw / mg / yt…）只在两处不同：网易云 wyy≠wy、QQ qq≠tx，
  // 其余恒等。getUrl 入参是 qt id，交给脚本的 source 字段必须是洛雪名，
  // 否则脚本 `apis[source]` 解构不到入口。两张表都在函数体内——函数体要被
  // 打包器 toString() 内嵌进产物，不能引用模块作用域。
  var QT_TO_LX_SOURCE = { wyy: "wy", qq: "tx" };
  var LX_TO_QT_SOURCE = { wy: "wyy", tx: "qq" };

  // ───────────────────────────── 每次取链的可变状态 ─────────────────────────────

  var handler = null; // v2：lx.on("request", h)
  var legacyHandler = null; // v1：onRequest(id, option)
  var initedData = null; // lx.send("inited", ...) 上报的注册面
  var currentMusicInfo = null; // 脚本读 lx.currentMusicInfo 时给它当前曲目
  var started = false;

  // ───────────────────────────── lx mock ─────────────────────────────

  var lx = {
    EVENT_NAMES: {
      request: "request",
      inited: "inited",
      updateAlert: "updateAlert",
      showConfigView: "showConfigView",
    },
    version: "2.0.0",
    apiVersion: "1.3.0",
    env: "desktop",
    on: function (name, h) {
      if (name === "request") handler = h;
    },
    send: function (name, data) {
      if (name === "inited") initedData = data;
    },
    request: function (url, options, cb) {
      var opts = options || {};
      var done = typeof cb === "function" ? cb : function () {};
      (function () {
        Promise.resolve()
          .then(function () {
            var dead = deadBackendOf(url);
            if (dead) throw new Error("后端 " + dead + " 已失效，跳过（剪线快速失败）");
            var method = typeof opts.method === "string" ? opts.method.toUpperCase() : "GET";
            var body;
            if (typeof opts.body === "string") body = opts.body;
            else if (opts.body !== undefined && opts.body !== null) body = JSON.stringify(opts.body);
            else if (opts.form) {
              var parts = [];
              for (var k in opts.form) {
                if (Object.prototype.hasOwnProperty.call(opts.form, k)) {
                  parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(String(opts.form[k])));
                }
              }
              body = parts.join("&");
            }
            return Promise.resolve(
              host.request(url, {
                method: method === "POST" ? "POST" : "GET",
                headers: opts.headers,
                body: body,
                timeoutMs: typeof opts.timeout === "number" ? opts.timeout : 15000,
              }),
            ).then(function (res) {
              done(null, { statusCode: res.statusCode, headers: res.headers, body: res.body });
            });
          })
          .catch(function (err) {
            done(err);
          });
      })();
    },
    currentScriptInfo: {
      name: scriptName,
      description: header.description || "packed by qt-sources-sdk lx packer",
      version: header.version,
      author: header.author,
      rawScript: scriptText,
    },
    utils: {
      serialize: function (v) {
        try {
          return JSON.stringify(v);
        } catch (e) {
          return "";
        }
      },
      deserialize: function (s) {
        try {
          return JSON.parse(s);
        } catch (e) {
          return null;
        }
      },
      base64: {
        encode: function (v) {
          return base64Encode(typeof v === "string" ? utf8BytesOf(v) : toBytes(v));
        },
        decode: function (v) {
          return base64Decode(String(v));
        },
      },
      parseQuery: function (url) {
        var out = {};
        var q = String(url).split("?")[1];
        if (!q) return out;
        var pairs = q.split("&");
        for (var i = 0; i < pairs.length; i++) {
          var kv = pairs[i].split("=");
          if (kv[0]) out[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1] || "");
        }
        return out;
      },
      parseCookie: function (text) {
        var out = {};
        var parts = String(text).split(";");
        for (var i = 0; i < parts.length; i++) {
          var kv = parts[i].split("=");
          if (kv[0] && kv[0].trim()) out[kv[0].trim()] = (kv[1] || "").trim();
        }
        return out;
      },
      zlib: {
        // 未实现：真正的 deflate 解压器体积不划算。调用即抛，别静默返回错数据。
        inflate: function () {
          throw new Error("lx.utils.zlib 未实现：本运行时不含 deflate 解压器");
        },
        deflate: function () {
          throw new Error("lx.utils.zlib 未实现：本运行时不含 deflate 解压器");
        },
      },
      log: function () {},
      toast: function () {},
      exit: function () {},
      crypto: {
        md5: function (s) {
          return md5Hex(String(s));
        },
        randomBytes: randomBytes,
        randomInt: function (a, b) {
          var lo = Number(a) || 0;
          var hi = Number(b) || 0;
          return lo + Math.floor(Math.random() * (hi - lo));
        },
        aesEncrypt: aesEncrypt,
        // 与构建仓同口径：只有「配置上报」类路径会调它，不在取链主链上
        rsaEncrypt: function () {
          return "";
        },
      },
      buffer: {
        from: bufferFrom,
        bufToString: bufferToString,
        toHex: bytesToHex,
        fromHex: hexToBytes,
        fromBase64: base64Decode,
        toBase64: function (b) {
          return base64Encode(toBytes(b));
        },
      },
    },
  };

  // lx.currentMusicInfo：部分 v2 脚本读它而不是读 handler 入参
  try {
    Object.defineProperty(lx, "currentMusicInfo", {
      get: function () {
        return currentMusicInfo;
      },
      enumerable: true,
      configurable: true,
    });
  } catch (e) {
    lx.currentMusicInfo = null;
  }

  // ───────────────────────────── 遮蔽执行 ─────────────────────────────

  /**
   * 形参名即「被遮蔽的裸标识符」。脚本体里出现的这些名字会解析到我们注入的对象，
   * 其余（Date / JSON / BigInt / Math…）落真实全局。
   *
   * 注意：这里刻意包含 setTimeout / setInterval —— 混淆脚本的反调试回调挂在它们上面，
   * 必须真正拦下来（构建仓放在 globalThis 覆盖表里是拦不住的，裸标识符不走 Proxy）。
   */
  var SHADOW_NAMES = [
    "globalThis",
    "window",
    "self",
    "process",
    "lx",
    "SCRIPT_MD5",
    "console",
    "Buffer",
    "require",
    "module",
    "exports",
    "setTimeout",
    "setInterval",
    "setImmediate",
  ];

  function buildSandbox() {
    var overrides = {
      lx: lx,
      SCRIPT_MD5: scriptMd5,
    };

    // 定时器：回调包 try/catch（反调试的无限递归 / debugger 循环异常不外抛）
    function safeSetTimeout(fn, ms) {
      var extra = Array.prototype.slice.call(arguments, 2);
      return setTimeout(function () {
        try {
          if (typeof fn === "function") fn.apply(null, extra);
        } catch (e) {
          /* 反调试/脚本异常不外抛 */
        }
      }, ms);
    }
    function safeSetInterval(fn, ms) {
      var extra = Array.prototype.slice.call(arguments, 2);
      return setInterval(function () {
        try {
          if (typeof fn === "function") fn.apply(null, extra);
        } catch (e) {
          /* 同上 */
        }
      }, ms);
    }

    var realGlobal = globalThis;
    var globalMock = new Proxy(
      {},
      {
        get: function (_t, key) {
          if (typeof key === "symbol") return realGlobal[key];
          if (Object.prototype.hasOwnProperty.call(overrides, key)) return overrides[key];
          return realGlobal[key];
        },
        set: function (_t, key, value) {
          if (typeof key === "string") overrides[key] = value;
          return true;
        },
        has: function () {
          return true;
        },
      },
    );

    var processStub = {
      env: {},
      platform: "win32",
      version: "2.0.0",
      argv: [],
      nextTick: function (fn) {
        var extra = Array.prototype.slice.call(arguments, 1);
        setTimeout(function () {
          try {
            fn.apply(null, extra);
          } catch (e) {
            /* 同上 */
          }
        }, 0);
      },
      // 反调试：真实 process 下部分脚本会静默 exit(1)
      exit: function () {
        throw new Error("process.exit blocked by qt lx runtime");
      },
    };

    function noop() {}
    var silentConsole = {
      log: noop, error: noop, warn: noop, info: noop, debug: noop, trace: noop,
      group: noop, groupEnd: noop, groupCollapsed: noop, table: noop, dir: noop,
      time: noop, timeEnd: noop, assert: noop, count: noop, clear: noop,
    };

    var moduleStub = { exports: {} };
    var requireStub = function (id) {
      throw new Error("本运行时无 CommonJS 环境，无法加载模块：" + String(id));
    };
    requireStub.cache = {};

    var bufferStub = {
      from: function (v) {
        return asNodeBuffer(typeof v === "string" ? bufferFrom(v) : toBytes(v));
      },
      alloc: function (n) {
        return asNodeBuffer(new Uint8Array(Number(n) || 0));
      },
      byteLength: function (v) {
        return (typeof v === "string" ? utf8BytesOf(v) : toBytes(v)).length;
      },
      isBuffer: function (v) {
        return v instanceof Uint8Array;
      },
      concat: function (list) {
        var total = 0;
        var i;
        for (i = 0; i < list.length; i++) total += toBytes(list[i]).length;
        var out = new Uint8Array(total);
        var at = 0;
        for (i = 0; i < list.length; i++) {
          var b = toBytes(list[i]);
          out.set(b, at);
          at += b.length;
        }
        return asNodeBuffer(out);
      },
    };

    var args = [
      globalMock,
      globalMock,
      globalMock,
      processStub,
      lx,
      scriptMd5,
      silentConsole,
      bufferStub,
      requireStub,
      moduleStub,
      moduleStub.exports,
      safeSetTimeout,
      safeSetInterval,
      safeSetTimeout,
    ];

    return { args: args, moduleStub: moduleStub };
  }

  function start() {
    if (started) return;
    started = true;
    var sandbox = buildSandbox();
    // 脚本本体放进带遮蔽形参的函数体执行；尾部把脚本作用域里的 v1 入口捞回来。
    var tail =
      "\n;return { onRequest: typeof onRequest === 'function' ? onRequest : null," +
      " onEvent: typeof onEvent === 'function' ? onEvent : null };";
    var factory;
    try {
      factory = new Function(SHADOW_NAMES.join(","), scriptText + tail);
    } catch (e) {
      throw new Error("洛雪源脚本语法错误，无法装载：" + (e && e.message ? e.message : String(e)));
    }
    var exported;
    try {
      exported = factory.apply(
        null,
        sandbox.args,
      );
    } catch (e) {
      throw new Error("洛雪源脚本执行失败：" + (e && e.message ? e.message : String(e)));
    }
    // v1 入口优先级：顶层 onRequest > module.exports.onRequest
    if (exported && typeof exported.onRequest === "function") legacyHandler = exported.onRequest;
    else if (sandbox.moduleStub.exports && typeof sandbox.moduleStub.exports.onRequest === "function") {
      legacyHandler = sandbox.moduleStub.exports.onRequest;
    }
  }

  var readyPromise = null;

  function ensureReady() {
    if (readyPromise === null) {
      readyPromise = Promise.resolve().then(function () {
        start();
        if (handler !== null || legacyHandler !== null) return null;
        // 混淆脚本可能有异步初始化：轮询等 handler 注册
        var deadline = Date.now() + initTimeoutMs;
        return new Promise(function (resolve, reject) {
          (function poll() {
            if (handler !== null || legacyHandler !== null) return resolve(null);
            if (Date.now() > deadline) {
              return reject(
                new Error("洛雪源「" + scriptName + "」未注册取链入口（既无 lx.on(request) 也无 onRequest）"),
              );
            }
            setTimeout(poll, 50);
          })();
        });
      });
    }
    return readyPromise;
  }

  /** 契约音质 "128"/"320"/"flac" → LX 口径 "128k"/"320k"/"flac"（构建仓同口径） */
  function toLxQuality(quality) {
    var q = String(quality == null ? "" : quality);
    if (q === "flac" || q === "flac24bit" || q === "hires") return q === "flac" ? "flac" : "flac24bit";
    if (/^\d+$/.test(q)) return q + "k";
    return q;
  }

  function withTimeout(promise, ms, label) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        reject(new Error(label + "：洛雪源 " + ms + "ms 内未返回"));
      }, ms);
      Promise.resolve(promise).then(
        function (v) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(v);
        },
        function (e) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          reject(e);
        },
      );
    });
  }

  return {
    /** 脚本展示名（@name 头或调用方指定） */
    scriptName: scriptName,
    /** md5(脚本原文)，脚本自检会用 SCRIPT_MD5 比它 */
    scriptMd5: scriptMd5,
    /** 脚本头解析结果 */
    header: header,

    ensureReady: ensureReady,

    /**
     * 取链。song 为契约 MusicInfo（至少要 id/name/singer/album）。
     * 成功 resolve 播放地址字符串；失败 reject（错误文本即用户可见诊断）。
     */
    getUrl: function (source, song, quality) {
      return ensureReady().then(function () {
        // qt 平台 id → 洛雪协议平台名（wyy→wy、qq→tx，其余恒等）
        var lxSource = QT_TO_LX_SOURCE[source] || source;

        // 提前挡一道「源没声明这个平台」。真实洛雪客户端只会问它上报过的平台，
        // 可宿主的取链调用不一定：脚本内部普遍写成 apis[source].musicUrl(...)，
        // 没声明的平台会让 apis[source] 是 undefined，用户看到的就是一句
        // "Cannot read properties of undefined" 天书。这里先替它回一句人话。
        // 只在脚本确实上报过平台时挡——从不上报的源（v1 老脚本居多）不误伤。
        var declared = initedData && initedData.sources ? Object.keys(initedData.sources) : null;
        if (declared && declared.length > 0 && declared.indexOf(lxSource) < 0) {
          throw new Error(
            "洛雪源「" + scriptName + "」不支持该平台（它只声明了 " + declared.join("/") + "）",
          );
        }
        var musicInfo = {
          // 各平台脚本解构的 id 字段不同：tx/wy 用 songmid、kg 用 hash、
          // kw 用 rid/songmid、mg 用 copyrightId——本项目各平台 id 恰好同值
          songmid: song.id,
          id: song.id,
          hash: song.id,
          rid: song.id,
          copyrightId: song.id,
          name: song.name,
          singer: song.singer,
          albumName: song.album,
          album: song.album,
          picUrl: song.picUrl,
          interval: song.interval,
          duration: song.interval,
        };
        var type = toLxQuality(quality);
        currentMusicInfo = musicInfo;

        var h = handler;
        if (h) {
          return withTimeout(
            Promise.resolve(h({ action: "musicUrl", source: lxSource, info: { musicInfo: musicInfo, type: type } })),
            callTimeoutMs,
            "取链超时",
          ).then(function (url) {
            if (typeof url === "string" && url.trim()) return url;
            if (url && typeof url === "object" && typeof url.url === "string") return url.url;
            throw new Error("洛雪源 " + lxSource + " 未返回播放地址（handler 返回 " + typeof url + "）");
          });
        }
        if (legacyHandler) {
          // v1 口径：id 用 lx_MUSIC_URL，option 同时给出三种质量字段名
          var option = {
            action: "musicUrl",
            source: lxSource,
            musicInfo: musicInfo,
            type: type,
            quality: type,
            music_quality: type,
          };
          return withTimeout(
            Promise.resolve(legacyHandler("lx_MUSIC_URL", option)),
            callTimeoutMs,
            "取链超时",
          ).then(function (url) {
            if (typeof url === "string" && url.trim()) return url;
            if (url && typeof url === "object" && typeof url.url === "string") return url.url;
            throw new Error("洛雪源 " + lxSource + " 未返回播放地址（onRequest 返回 " + typeof url + "）");
          });
        }
        throw new Error("洛雪源「" + scriptName + "」没有可用的取链入口");
      });
    },

    /** init 上报的注册平台（洛雪协议名：wy/tx/kg/kw/mg…；转 qt id 用模块级映射表） */
    registeredSources: function () {
      return initedData && initedData.sources ? Object.keys(initedData.sources) : [];
    },

    /** 某平台宣称的音质列表（"128k"/"320k"/"flac"/"flac24bit"）；source 可传 qt id 或洛雪名 */
    claimedQualities: function (source) {
      var s = initedData && initedData.sources ? initedData.sources[QT_TO_LX_SOURCE[source] || source] : null;
      var q = (s && (s.qualitys || s.qualities)) || [];
      return Array.isArray(q) ? q : [];
    },

    /** 脚本是否注册了取链入口（探测用，不触发初始化） */
    hasHandler: function () {
      return handler !== null || legacyHandler !== null;
    },
  };
}

/**
 * qt 平台 id → 洛雪协议平台名。
 *
 * 只列**不恒等**的两条（wyy→wy、qq→tx）；其余平台（kg/kw/mg/yt/bili…）两边同名，
 * 映射函数一律 `QT_TO_LX_SOURCE[source] || source`。运行时函数体内有一份同值的
 * 静态表（函数体要 toString() 内嵌进产物，不能引用模块作用域），改这里务必同步改那里。
 */
export const QT_TO_LX_SOURCE = { wyy: "wy", qq: "tx" };

/** 洛雪协议平台名 → qt 平台 id（同样是「只列不恒等的两条」）。 */
export const LX_TO_QT_SOURCE = { wy: "wyy", tx: "qq" };
