/*
 * Token budget for one tutor turn (one question, one answer).
 *
 * Anthropic requires input_tokens + max_tokens to fit the context window.
 * The hard ceiling is CONTEXT_LIMIT (100000). HEADROOM (20000) is never
 * filled, so the instruction prompt is not crowded out by images and text:
 *
 *   input_estimate + max_tokens <= TOKEN_BUDGET (80000)
 *
 * MAX_TOKENS (32000) is reserved for adaptive thinking plus the answer.
 * Thinking counts toward max_tokens. The other 48000 (INPUT_BUDGET) is the
 * input: system prompt, question, files, schema, slide text, images.
 *
 * Estimates (rounded up):
 *   text  — ceil(chars / 4)
 *   image — ceil(width * height / 750), from the PNG, JPEG, or GIF header
 *           (no full decode). An unreadable image is billed over the input
 *           budget so it is dropped instead of being allowed past the ceiling.
 *
 * Trim order, stopping as soon as the input fits:
 *   1. images, last first, including a screenshot that does not fit
 *      (a "Bild von Folie N" or "Screenshot N" label goes with its image)
 *   2. slide text ([Folie N | …] sections), shortened from the end
 *   3. attached file text
 *   4. schema, only if it still does not fit
 *   5. the question text, only if it still does not fit
 * The system prompt is never edited.
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = mod;
  if (typeof window !== "undefined") window.TokenBudget = mod;
  else if (typeof globalThis !== "undefined") globalThis.TokenBudget = mod;
})(this, function () {
  "use strict";

  const CONTEXT_LIMIT = 100000;
  const HEADROOM = 20000;
  const TOKEN_BUDGET = CONTEXT_LIMIT - HEADROOM; // 80000
  const MAX_TOKENS = 32000;
  const INPUT_BUDGET = TOKEN_BUDGET - MAX_TOKENS; // 48000
  // Client calls pass system="" and subtract this, so they trim at least as
  // hard as the server (which counts the real system prompt inside INPUT_BUDGET).
  // tests/stream.test.js checks the real prompt is within this reserve.
  const SYSTEM_RESERVE = 2000;

  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const B64I = new Int16Array(128);
  for (let i = 0; i < 128; i++) B64I[i] = -1;
  for (let i = 0; i < 64; i++) B64I[B64.charCodeAt(i)] = i;

  function textTokens(s) {
    const n = String(s == null ? "" : s).length;
    return n ? Math.ceil(n / 4) : 0;
  }

  function normalizeB64(data) {
    let s = String(data || "");
    const comma = s.indexOf(",");
    if (s.slice(0, 5) === "data:" && comma !== -1) s = s.slice(comma + 1);
    return s.replace(/\s/g, "").replace(/-/g, "+").replace(/_/g, "/").replace(/[^A-Za-z0-9+/]/g, "");
  }

  function decodeB64(b64, maxBytes) {
    const clean = normalizeB64(b64);
    const chars = maxBytes ? Math.min(clean.length, Math.ceil(maxBytes / 3) * 4) : clean.length;
    const outLen = Math.floor(chars * 3 / 4);
    const out = new Uint8Array(outLen);
    let o = 0;
    for (let i = 0; i + 1 < chars && o < outLen; i += 4) {
      const a = B64I[clean.charCodeAt(i)] | 0;
      const b = B64I[clean.charCodeAt(i + 1)] | 0;
      const c = i + 2 < chars ? B64I[clean.charCodeAt(i + 2)] : -1;
      const d = i + 3 < chars ? B64I[clean.charCodeAt(i + 3)] : -1;
      if (a < 0 || b < 0) break;
      const n = (a << 18) | (b << 12) | ((c < 0 ? 0 : c) << 6) | (d < 0 ? 0 : d);
      out[o++] = (n >> 16) & 255;
      if (c >= 0 && o < outLen) out[o++] = (n >> 8) & 255;
      if (d >= 0 && o < outLen) out[o++] = n & 255;
    }
    return out.subarray(0, o);
  }

  function u16be(b, o) { return (b[o] << 8) | b[o + 1]; }
  function u32be(b, o) {
    return b[o] * 16777216 + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
  }

  function pngSize(bytes) {
    if (bytes.length < 24) return null;
    if (bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return null;
    const w = u32be(bytes, 16);
    const h = u32be(bytes, 20);
    return w > 0 && h > 0 ? { w: w, h: h } : null;
  }

  function gifSize(bytes) {
    if (bytes.length < 10) return null;
    if (bytes[0] !== 0x47 || bytes[1] !== 0x49 || bytes[2] !== 0x46) return null;
    const w = bytes[6] | (bytes[7] << 8);
    const h = bytes[8] | (bytes[9] << 8);
    return w > 0 && h > 0 ? { w: w, h: h } : null;
  }

  // SOF0–SOF3, SOF5–SOF7, SOF9–SOF11, SOF13–SOF15. Returns null if the marker
  // is not in this buffer (caller may retry with a longer prefix).
  function jpegSize(bytes) {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
    let i = 2;
    while (i + 8 < bytes.length) {
      if (bytes[i] !== 0xff) { i++; continue; }
      while (i < bytes.length && bytes[i] === 0xff) i++;
      if (i >= bytes.length) return null;
      const marker = bytes[i];
      i++;
      if (marker === 0x00) continue; // stuffed FF
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) continue;
      if (i + 1 >= bytes.length) return null;
      const len = u16be(bytes, i);
      if (len < 2) return null;
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        if (i + 7 >= bytes.length) return null;
        const h = u16be(bytes, i + 3);
        const w = u16be(bytes, i + 5);
        return w > 0 && h > 0 ? { w: w, h: h } : null;
      }
      if (marker === 0xda) return null; // start of scan, no SOF in this buffer
      i += len;
    }
    return null;
  }

  function imageSize(bytes) {
    if (!bytes || !bytes.length) return null;
    if (bytes[0] === 0x89 && bytes[1] === 0x50) return pngSize(bytes);
    if (bytes[0] === 0x47 && bytes[1] === 0x49) return gifSize(bytes);
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return jpegSize(bytes);
    return null;
  }

  function dimensionsOf(block) {
    const data = block && block.data;
    const head = decodeB64(data, 65536);
    let dim = imageSize(head);
    if (!dim && head.length >= 65536 && head[0] === 0xff && head[1] === 0xd8) {
      dim = jpegSize(decodeB64(data, 2 * 1024 * 1024));
    }
    return dim;
  }

  function imageTokensFromSize(w, h) {
    w = w | 0;
    h = h | 0;
    if (w <= 0 || h <= 0) return INPUT_BUDGET + 1;
    return Math.ceil((w * h) / 750);
  }

  function imageTokens(block, cache) {
    const data = block && block.data ? String(block.data) : "";
    if (cache && cache.has(data)) return cache.get(data);
    const dim = dimensionsOf(block);
    // Unreadable: over the input budget so the image is dropped, never billed short.
    const tokens = dim ? imageTokensFromSize(dim.w, dim.h) : (INPUT_BUDGET + 1);
    if (cache) cache.set(data, tokens);
    return tokens;
  }

  function blockTokens(block, cache) {
    if (!block) return 0;
    if (typeof block === "string") return textTokens(block);
    if (block.type === "image") return imageTokens(block, cache);
    return textTokens(block.text || "");
  }

  function messageTokens(messages, system, cache) {
    let n = textTokens(system);
    for (const m of messages || []) {
      const c = m && m.content;
      if (typeof c === "string" || !Array.isArray(c)) n += textTokens(c);
      else for (const b of c) n += blockTokens(b, cache);
    }
    return n;
  }

  function isImageLabel(text) {
    return /^(?:Bild von Folie \d+|Screenshot \d+)$/.test(String(text || "").trim());
  }

  function cloneMessages(messages) {
    return (messages || []).map((m) => {
      if (!m || typeof m !== "object") return { role: "user", content: "" };
      if (!Array.isArray(m.content)) return { role: m.role, content: m.content };
      return {
        role: m.role,
        content: m.content.map((b) => (b && typeof b === "object" ? Object.assign({}, b) : b)),
      };
    });
  }

  function dropLastImage(messages) {
    for (let mi = messages.length - 1; mi >= 0; mi--) {
      const content = messages[mi] && messages[mi].content;
      if (!Array.isArray(content)) continue;
      for (let i = content.length - 1; i >= 0; i--) {
        if (!content[i] || content[i].type !== "image") continue;
        let from = i;
        const prev = content[i - 1];
        if (prev && prev.type !== "image" && isImageLabel(prev.text)) from = i - 1;
        content.splice(from, i - from + 1);
        return true;
      }
    }
    return false;
  }

  function parseSections(text) {
    const s = String(text == null ? "" : text);
    if (isImageLabel(s)) return [{ kind: "label", text: s }];
    const re = /(?:^|\n\n)(\[Folie \d+ \|[^\]]*\]|Schema \([^)\n]*\):|### [^\n]*)/g;
    const marks = [];
    let m;
    while ((m = re.exec(s))) {
      const lead = m[0].charAt(0) === "\n" ? 2 : 0;
      const header = m[1];
      const kind = header.charAt(0) === "[" ? "slide" : header.charAt(0) === "S" ? "schema" : "file";
      marks.push({ start: m.index + lead, header: header, kind: kind });
      if (m.index === re.lastIndex) re.lastIndex++;
    }
    if (!marks.length) return [{ kind: "question", text: s }];
    const parts = [];
    const q = s.slice(0, marks[0].start).replace(/\n\n$/, "");
    if (q) parts.push({ kind: "question", text: q });
    for (let i = 0; i < marks.length; i++) {
      const end = i + 1 < marks.length ? marks[i + 1].start : s.length;
      let chunk = s.slice(marks[i].start, end).replace(/\n\n$/, "");
      const header = marks[i].header;
      let body = "";
      if (chunk.startsWith(header)) body = chunk.slice(header.length).replace(/^\n/, "");
      else body = chunk;
      parts.push({ kind: marks[i].kind, header: header, body: body });
    }
    return parts;
  }

  function joinSections(parts) {
    const chunks = [];
    for (const p of parts) {
      if (!p) continue;
      if (p.kind === "question" || p.kind === "label") {
        if (p.text) chunks.push(p.text);
        continue;
      }
      if (!p.header) continue;
      chunks.push(p.body ? p.header + "\n" + p.body : p.header);
    }
    return chunks.join("\n\n");
  }

  function textSlots(messages) {
    const slots = [];
    for (const m of messages || []) {
      if (!m) continue;
      if (!Array.isArray(m.content)) {
        slots.push({
          get: function () { return typeof m.content === "string" ? m.content : ""; },
          set: function (t) { m.content = t; },
        });
        continue;
      }
      for (let bi = 0; bi < m.content.length; bi++) {
        const b = m.content[bi];
        if (!b || b.type === "image") continue;
        slots.push({
          get: function () { return b.text || ""; },
          set: function (t) { b.text = t; },
        });
      }
    }
    return slots;
  }

  function editKind(messages, kind, fn) {
    const slots = textSlots(messages);
    for (let i = slots.length - 1; i >= 0; i--) {
      const parts = parseSections(slots[i].get());
      if (!parts.some((p) => p.kind === kind)) continue;
      if (fn(parts)) {
        slots[i].set(joinSections(parts));
        return true;
      }
    }
    return false;
  }

  // Cut `chars` from the end of this kind's bodies (questions use their text).
  function cutKind(messages, kind, chars) {
    let left = chars;
    const slots = textSlots(messages);
    for (let i = slots.length - 1; i >= 0 && left > 0; i--) {
      const parts = parseSections(slots[i].get());
      const before = left;
      for (let p = parts.length - 1; p >= 0 && left > 0; p--) {
        if (parts[p].kind !== kind) continue;
        const field = kind === "question" ? "text" : "body";
        const body = parts[p][field] || "";
        if (!body) continue;
        const n = Math.min(body.length, left);
        parts[p][field] = body.slice(0, body.length - n);
        left -= n;
      }
      if (left !== before) slots[i].set(joinSections(parts));
    }
    return left < chars;
  }

  function dropKind(messages, kind) {
    return editKind(messages, kind, (parts) => {
      for (let p = parts.length - 1; p >= 0; p--) {
        if (parts[p].kind !== kind) continue;
        parts.splice(p, 1);
        return true;
      }
      return false;
    });
  }

  function shrinkKind(messages, system, budget, cache, kind, dropSections) {
    let changed = false;
    let guard = 0;
    while (messageTokens(messages, system, cache) > budget && guard++ < 24) {
      const over = messageTokens(messages, system, cache) - budget;
      if (!cutKind(messages, kind, over * 4 + 4)) break;
      changed = true;
    }
    if (dropSections) {
      let g2 = 0;
      while (messageTokens(messages, system, cache) > budget && g2++ < 500) {
        const before = messageTokens(messages, system, cache);
        if (!dropKind(messages, kind)) break;
        changed = true;
        if (messageTokens(messages, system, cache) >= before) break;
      }
    }
    return changed;
  }

  // Last resort so a parse miss cannot leave the turn over the budget.
  function forceTrim(messages, system, budget, cache) {
    let changed = false;
    let guard = 0;
    while (messageTokens(messages, system, cache) > budget && guard++ < 40) {
      if (dropLastImage(messages)) { changed = true; continue; }
      const slots = textSlots(messages);
      let longest = null;
      let longestLen = 0;
      for (const slot of slots) {
        const t = slot.get();
        if (t.length > longestLen) { longest = slot; longestLen = t.length; }
      }
      if (!longest || longestLen === 0) break;
      const keep = Math.floor(longestLen / 2);
      if (keep >= longestLen) break;
      longest.set(longest.get().slice(0, keep));
      changed = true;
    }
    return changed;
  }

  function cleanup(messages) {
    for (const m of messages) {
      if (!m || !Array.isArray(m.content)) continue;
      m.content = m.content.filter((b) => {
        if (!b) return false;
        if (b.type === "image") return !!b.data;
        return String(b.text || "").length > 0;
      });
    }
  }

  function hasContent(messages) {
    for (const m of messages || []) {
      if (!m) continue;
      if (typeof m.content === "string" && m.content.trim()) return true;
      if (!Array.isArray(m.content)) continue;
      for (const b of m.content) {
        if (!b) continue;
        if (b.type === "image" && b.data) return true;
        if (String(b.text || "").trim()) return true;
      }
    }
    return false;
  }

  function ensureNonEmpty(messages) {
    if (!messages || !messages.length || hasContent(messages)) return;
    const m = messages[0];
    if (!m) return;
    if (Array.isArray(m.content)) m.content = [{ type: "text", text: "." }];
    else m.content = ".";
  }

  function clampBudget(opts) {
    if (opts && Number.isFinite(opts.inputBudget)) {
      return Math.min(INPUT_BUDGET, Math.max(0, opts.inputBudget));
    }
    return INPUT_BUDGET;
  }

  function fitTutorTurn(messages, system, opts) {
    const inputBudget = clampBudget(opts);
    const cache = new Map();
    const fitted = cloneMessages(messages);
    const before = messageTokens(fitted, system, cache);
    let changed = false;
    const over = () => messageTokens(fitted, system, cache) > inputBudget;

    while (over()) {
      if (!dropLastImage(fitted)) break;
      changed = true;
    }
    if (over() && shrinkKind(fitted, system, inputBudget, cache, "slide", true)) changed = true;
    if (over() && shrinkKind(fitted, system, inputBudget, cache, "file", true)) changed = true;
    if (over() && shrinkKind(fitted, system, inputBudget, cache, "schema", true)) changed = true;
    if (over() && shrinkKind(fitted, system, inputBudget, cache, "question", false)) changed = true;
    if (over() && forceTrim(fitted, system, inputBudget, cache)) changed = true;
    cleanup(fitted);
    ensureNonEmpty(fitted);
    const tokens = messageTokens(fitted, system, cache);
    return {
      messages: fitted,
      tokens: tokens,
      before: before,
      trimmed: changed,
      maxTokens: MAX_TOKENS,
      inputBudget: inputBudget,
      total: tokens + MAX_TOKENS,
    };
  }

  return {
    CONTEXT_LIMIT: CONTEXT_LIMIT,
    HEADROOM: HEADROOM,
    TOKEN_BUDGET: TOKEN_BUDGET,
    MAX_TOKENS: MAX_TOKENS,
    INPUT_BUDGET: INPUT_BUDGET,
    SYSTEM_RESERVE: SYSTEM_RESERVE,
    textTokens: textTokens,
    imageTokens: imageTokens,
    imageTokensFromSize: imageTokensFromSize,
    messageTokens: messageTokens,
    fitTutorTurn: fitTutorTurn,
  };
});
