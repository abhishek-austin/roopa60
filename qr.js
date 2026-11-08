/* qr.js — a tiny, dependency-free QR code encoder.
 *
 * Byte mode, error-correction level M, versions 1–10 (up to 216 bytes of
 * UTF-8 text). That is plenty for a guest link. Exposes:
 *
 *   QR.encode(text)                  -> { size, modules: Uint8Array(size*size) }
 *   QR.drawCanvas(canvas, text, px)  -> renders with a 4-module quiet zone
 *   QR.toSVG(text)                   -> SVG markup string
 */
(function (global) {
  "use strict";

  // version -> [ecCodewordsPerBlock, [[blockCount, dataCodewordsPerBlock], ...]]  (level M)
  const EC_TABLE = {
    1: [10, [[1, 16]]], 2: [16, [[1, 28]]], 3: [26, [[1, 44]]], 4: [18, [[2, 32]]],
    5: [24, [[2, 43]]], 6: [16, [[4, 27]]], 7: [18, [[4, 31]]], 8: [22, [[2, 38], [2, 39]]],
    9: [22, [[3, 36], [2, 37]]], 10: [26, [[4, 43], [1, 44]]]
  };
  const ALIGN = {
    2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
    7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50]
  };
  const EC_LEVEL_BITS = 0; // M

  // ---- GF(256) arithmetic for Reed–Solomon ----
  const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  (function () {
    let x = 1;
    for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();
  function gmul(a, b) { return (a && b) ? EXP[LOG[a] + LOG[b]] : 0; }
  function rsGenerator(n) {
    let g = [1];
    for (let i = 0; i < n; i++) {
      const ng = new Array(g.length + 1).fill(0);
      for (let j = 0; j < g.length; j++) { ng[j] ^= g[j]; ng[j + 1] ^= gmul(g[j], EXP[i]); }
      g = ng;
    }
    return g;
  }
  function rsEncode(data, n) {
    const gen = rsGenerator(n), rem = new Array(n).fill(0);
    for (const d of data) {
      const f = d ^ rem[0];
      rem.shift(); rem.push(0);
      if (f) for (let j = 0; j < n; j++) rem[j] ^= gmul(gen[j + 1], f);
    }
    return rem;
  }

  function dataCodewords(v) { return EC_TABLE[v][1].reduce((s, [n, d]) => s + n * d, 0); }

  function encode(text) {
    const bytes = Array.from(new TextEncoder().encode(String(text)));
    let version = 0;
    for (let v = 1; v <= 10; v++) {
      const ccBits = v < 10 ? 8 : 16;
      if (4 + ccBits + bytes.length * 8 <= dataCodewords(v) * 8) { version = v; break; }
    }
    if (!version) throw new Error("QR: text too long (max ~210 bytes)");

    // ---- bit stream ----
    const bits = [];
    const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    push(0b0100, 4);
    push(bytes.length, version < 10 ? 8 : 16);
    bytes.forEach(b => push(b, 8));
    const capacity = dataCodewords(version) * 8;
    push(0, Math.min(4, capacity - bits.length));
    while (bits.length % 8) bits.push(0);
    for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(""), 2));

    // ---- split into blocks, compute EC, interleave ----
    const [ecLen, groups] = EC_TABLE[version];
    const blocks = [], ecs = [];
    let offset = 0;
    for (const [count, len] of groups) {
      for (let i = 0; i < count; i++) {
        const block = data.slice(offset, offset + len); offset += len;
        blocks.push(block); ecs.push(rsEncode(block, ecLen));
      }
    }
    const codewords = [];
    const maxLen = Math.max(...blocks.map(b => b.length));
    for (let i = 0; i < maxLen; i++) for (const b of blocks) if (i < b.length) codewords.push(b[i]);
    for (let i = 0; i < ecLen; i++) for (const e of ecs) codewords.push(e[i]);

    // ---- matrix ----
    const size = 17 + 4 * version;
    const modules = new Uint8Array(size * size);
    const func = new Uint8Array(size * size);
    const set = (x, y, dark) => { modules[y * size + x] = dark ? 1 : 0; func[y * size + x] = 1; };

    const finder = (cx, cy) => {
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        set(x, y, d !== 2 && d !== 4);
      }
    };
    finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
    for (let i = 8; i < size - 8; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
    if (ALIGN[version]) {
      const pos = ALIGN[version], last = pos.length - 1;
      pos.forEach((cy, i) => pos.forEach((cx, j) => {
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++)
          set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }));
    }
    // reserve format + version areas (values written after masking)
    for (let i = 0; i < 9; i++) if (i !== 6) { set(8, i, 0); set(i, 8, 0); }
    for (let i = 0; i < 8; i++) { set(size - 1 - i, 8, 0); set(8, size - 1 - i, 0); }
    if (version >= 7) for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3), b = Math.floor(i / 3);
      set(a, b, 0); set(b, a, 0);
    }

    // ---- place data (zigzag) ----
    const dataBits = [];
    codewords.forEach(c => { for (let i = 7; i >= 0; i--) dataBits.push((c >>> i) & 1); });
    let bi = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
        const x = right - j;
        const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
        if (!func[y * size + x]) { modules[y * size + x] = bi < dataBits.length ? dataBits[bi] : 0; bi++; }
      }
    }

    // ---- choose mask ----
    const MASKS = [
      (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x, y) => x % 3 === 0,
      (x, y) => (x + y) % 3 === 0, (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
      (x, y) => (x * y) % 2 + (x * y) % 3 === 0, (x, y) => ((x * y) % 2 + (x * y) % 3) % 2 === 0,
      (x, y) => ((x + y) % 2 + (x * y) % 3) % 2 === 0
    ];
    const applyMask = (m) => {
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++)
        if (!func[y * size + x] && MASKS[m](x, y)) modules[y * size + x] ^= 1;
    };
    const writeFormat = (mask) => {
      const dataF = (EC_LEVEL_BITS << 3) | mask;
      let rem = dataF;
      for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      const f = ((dataF << 10) | rem) ^ 0x5412;
      const bit = i => (f >>> i) & 1;
      for (let i = 0; i <= 5; i++) set(8, i, bit(i));
      set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
      for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
      for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
      for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
      set(8, size - 8, 1); // dark module
    };
    if (version >= 7) {
      let rem = version;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      const vbits = (version << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const b = (vbits >>> i) & 1, a = size - 11 + (i % 3), c = Math.floor(i / 3);
        set(a, c, b); set(c, a, b);
      }
    }
    const penalty = () => {
      let p = 0;
      const at = (x, y) => modules[y * size + x];
      for (let y = 0; y < size; y++) { // runs in rows / columns
        let rx = 1, ry = 1;
        for (let x = 1; x < size; x++) {
          rx = at(x, y) === at(x - 1, y) ? rx + 1 : 1; if (rx === 5) p += 3; else if (rx > 5) p += 1;
          ry = at(y, x) === at(y, x - 1) ? ry + 1 : 1; if (ry === 5) p += 3; else if (ry > 5) p += 1;
        }
      }
      for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) { // 2x2 blocks
        const c = at(x, y);
        if (c === at(x + 1, y) && c === at(x, y + 1) && c === at(x + 1, y + 1)) p += 3;
      }
      const pat = [1, 0, 1, 1, 1, 0, 1];
      for (let y = 0; y < size; y++) for (let x = 0; x + 10 < size; x++) { // finder-like patterns
        let h = true, v = true;
        for (let k = 0; k < 7; k++) { if (at(x + 4 + k, y) !== pat[k]) h = false; if (at(y, x + 4 + k) !== pat[k]) v = false; }
        if (h && [0, 1, 2, 3].every(k => !at(x + k, y))) p += 40;
        if (h && [7, 8, 9, 10].every(k => !at(x + k + 4, y) || false) && x + 14 < size && [11, 12, 13, 14].every(k => !at(x + k, y))) p += 40;
        if (v && [0, 1, 2, 3].every(k => !at(y, x + k))) p += 40;
      }
      let dark = 0; modules.forEach(m => dark += m);
      p += 10 * Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size));
      return p;
    };
    let best = 0, bestScore = Infinity;
    for (let m = 0; m < 8; m++) {
      applyMask(m); writeFormat(m);
      const s = penalty();
      if (s < bestScore) { bestScore = s; best = m; }
      applyMask(m);
    }
    applyMask(best); writeFormat(best);
    return { size, version, modules };
  }

  function drawCanvas(canvas, text, px = 6, quiet = 4) {
    const { size, modules } = encode(text);
    const total = (size + quiet * 2) * px;
    canvas.width = total; canvas.height = total;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, total, total);
    ctx.fillStyle = "#2b2a27";
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++)
      if (modules[y * size + x]) ctx.fillRect((x + quiet) * px, (y + quiet) * px, px, px);
    return canvas;
  }

  function toSVG(text, quiet = 4) {
    const { size, modules } = encode(text);
    const dim = size + quiet * 2;
    let d = "";
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++)
      if (modules[y * size + x]) d += `M${x + quiet} ${y + quiet}h1v1h-1z`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges">` +
      `<rect width="${dim}" height="${dim}" fill="#fff"/><path d="${d}" fill="#2b2a27"/></svg>`;
  }

  global.QR = { encode, drawCanvas, toSVG };
})(typeof window !== "undefined" ? window : globalThis);
