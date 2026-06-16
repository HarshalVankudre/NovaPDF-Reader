/*
 * SlideSearchEngine — a dependency-free, from-scratch relevance engine.
 *
 * Core ranking : Okapi BM25 (the proven IR standard) over an inverted index.
 * Intelligence : German-aware folding, prefix expansion (as-you-type),
 *                light stemming, fuzzy (typo) fallback, a bilingual DB
 *                synonym map, plus title / coverage / proximity boosts.
 *
 * Runs identically in the browser (window.SlideSearchEngine) and in Node
 * (module.exports) so it can be unit-tested from the command line.
 *
 * Complexity: build O(total tokens); query O(query terms x postings).
 * For 317 slides a full ranked query is well under 1 ms.
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = mod;
  if (typeof window !== "undefined") window.SlideSearchEngine = mod;
  else if (typeof globalThis !== "undefined") globalThis.SlideSearchEngine = mod;
})(this, function () {
  "use strict";

  const now = () =>
    typeof performance !== "undefined" && performance.now
      ? performance.now()
      : Date.now();

  // --- German/English stopwords (folded forms) ----------------------------
  const STOP = new Set(
    (
      "der die das des dem den ein eine einer eines einem einen und oder aber " +
      "wie was wann wo wer wem wen warum weshalb welche welcher welches welchem " +
      "ist sind war waren bin bist seid sein ob im in an auf zu zum zur von vom " +
      "mit fur ohne uber unter bei aus nach vor durch gegen um als wenn dann " +
      "dass weil damit sodass man kann konnen soll sollen muss mussen darf " +
      "wird werden wurde wurden hat habe haben hatte sich nicht auch nur noch " +
      "schon mehr sehr so es sie er ich du wir ihr mich dich uns euch ihm ihn " +
      "ihre ihren sein seine mein meine dein deine kein keine etc bzw bzgl ggf " +
      "the a an of to in on for and or but is are was were be been being how " +
      "what when where who why which that this these those do does did with " +
      "without about as if then so it its you we they i me my your our their " +
      "can could should would will shall has have had not no only more very " +
      "into at by from there here than such between each both all any some"
    ).split(/\s+/)
  );

  // --- Bilingual DB synonym groups (interchangeable folded tokens) --------
  // Folded: ä->a ö->o ü->u ß->ss.  Extend freely — this is the "semantic" layer.
  const SYN_GROUPS = [
    ["schlussel", "key"],
    ["primarschlussel", "pk", "primary"],
    ["fremdschlussel", "fk", "foreign"],
    ["join", "verbund", "verknupfung", "verknupft"],
    ["acid", "atomar", "atomicity", "isolation", "durability", "consistency"],
    ["normalform", "nf", "normalisierung", "normalisiert"],
    ["tabelle", "relation", "table", "tabellen"],
    ["spalte", "column", "attribut", "spalten", "attribute"],
    ["zeile", "row", "tupel", "datensatz", "zeilen"],
    ["abfrage", "query", "dql", "abfragen", "select"],
    ["loschen", "delete", "drop", "entfernen"],
    ["einfugen", "insert", "hinzufugen"],
    ["andern", "update", "aktualisieren", "modifizieren"],
    ["sicht", "view", "sichten"],
    ["transaktion", "transaction", "transaktionen"],
    ["gruppierung", "group", "gruppieren", "aggregation", "aggregat"],
    ["sortierung", "order", "sortieren", "sort"],
    ["beziehung", "relationship", "beziehungen"],
    ["entitat", "entity", "entitaten", "entitatstyp"],
    ["kardinalitat", "cardinality", "kardinalitaten"],
    ["bedingung", "where", "filter", "praedikat", "pradikat"],
    ["datentyp", "type", "datentypen"],
    ["constraint", "integritat", "integritatsbedingung", "constraints"],
    ["er", "ermodell", "entityrelationship"],

    // --- concept/intent bridges: how students phrase questions -> DB concept --
    // These let a paraphrased question match the slide even with no shared words
    // (e.g. "doppelte Werte verhindern" -> the UNIQUE slide).
    ["unique", "eindeutig", "eindeutigkeit", "doppelt", "doppelte", "duplikat", "duplikate", "mehrfach", "einzigartig"],
    ["null", "leer", "pflichtfeld", "fehlend", "notnull"],
    ["join", "kombinieren", "verbinden", "verbindung", "zusammenfuhren"],
    ["avg", "durchschnitt", "mittelwert", "average", "durchschnittlich"],
    ["sum", "summe", "gesamtsumme"],
    ["count", "anzahl", "zaehlen"],
    ["max", "maximum", "groesste", "hoechste"],
    ["min", "minimum", "kleinste", "niedrigste"],
    ["aggregat", "berechnen", "auswerten", "kennzahl", "statistik"],
    ["primarschlussel", "identifizieren", "identifikator", "eindeutig"],
    ["rollback", "abbruch", "abbrechen", "abgebrochen", "ruckgangig", "zurucksetzen", "fehlschlagen", "fehlgeschlagen", "scheitern"],
    ["sortierung", "reihenfolge", "ordnen", "aufsteigend", "absteigend"],
    ["where", "filtern", "einschranken", "einschrankung", "auswahlen"],
    ["loschen", "verwerfen", "entfernen"],
    ["einfugen", "anlegen", "erstellen", "speichern", "hinzufugen"],
    ["andern", "bearbeiten", "anpassen"],
    ["index", "schneller", "performance", "beschleunigen", "suchbaum"],
  ];

  // --- light, conservative suffix stemmer (DE + EN) -----------------------
  const SUFFIXES = [
    "ungen", "heiten", "keiten", "tionen", "innen", "nisse", "enen", "eren",
    "ung", "ten", "ung", "nen", "en", "er", "es", "em", "ns", "ig", "es",
    "e", "s", "n",
  ];
  function lightStem(t) {
    for (const suf of SUFFIXES) {
      if (t.length - suf.length >= 3 && t.endsWith(suf)) return t.slice(0, -suf.length);
    }
    return t;
  }

  // --- fold to a diacritic-free, lowercase canonical form -----------------
  function fold(s) {
    return s
      .toLowerCase()
      .replace(/ß/g, "ss")
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, ""); // strip combining marks (ä->a etc.)
  }

  const TOKEN_RE = /[\p{L}\p{N}]+/gu;
  function tokensWithPos(text) {
    const out = [];
    if (!text) return out;
    let m;
    TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(text)) !== null) {
      out.push({ raw: m[0], folded: fold(m[0]), start: m.index, end: m.index + m[0].length });
    }
    return out;
  }
  function contentTokens(text) {
    const out = [];
    for (const t of tokensWithPos(text)) {
      if (t.folded.length >= 2 && !STOP.has(t.folded)) out.push(t.folded);
    }
    return out;
  }

  function escHtml(s) {
    return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }
  function popcount(x) {
    x = x - ((x >> 1) & 0x55555555);
    x = (x & 0x33333333) + ((x >> 2) & 0x33333333);
    x = (x + (x >> 4)) & 0x0f0f0f0f;
    return (x * 0x01010101) >> 24;
  }
  // bounded Levenshtein: true if edit distance <= max (max small)
  function withinEdit(a, b, max) {
    const la = a.length, lb = b.length;
    if (Math.abs(la - lb) > max) return false;
    let prev = new Array(lb + 1);
    for (let j = 0; j <= lb; j++) prev[j] = j;
    for (let i = 1; i <= la; i++) {
      let cur = [i];
      let best = i;
      for (let j = 1; j <= lb; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        cur[j] = v;
        if (v < best) best = v;
      }
      if (best > max) return false; // whole row already exceeds budget
      prev = cur;
    }
    return prev[lb] <= max;
  }

  class SlideSearchEngine {
    constructor(slides, opts = {}) {
      this.slides = slides || [];
      this.k1 = opts.k1 ?? 1.4;
      this.b = opts.b ?? 0.7;
      this.titleBoost = opts.titleBoost ?? 2.5; // BM25F-style field weight
      this.coverageWeight = opts.coverageWeight ?? 0.45;
      this.proximityWeight = opts.proximityWeight ?? 0.3;
      this.prefixCap = opts.prefixCap ?? 16;
      this.rerankK = opts.rerankK ?? 60;
      this._build();
    }

    _build() {
      const t0 = now();
      const N = this.slides.length;
      this.N = N;
      this.docTokens = new Array(N);
      this.docLen = new Float64Array(N);
      const df = new Map();
      const docTermW = new Array(N); // per-doc Map(term -> weighted tf)

      for (let d = 0; d < N; d++) {
        const s = this.slides[d];
        const body = contentTokens(s.text || "");
        const title = contentTokens(s.title || "");
        this.docTokens[d] = body;
        this.docLen[d] = body.length || 1;
        const w = new Map();
        for (const t of body) w.set(t, (w.get(t) || 0) + 1);
        for (const t of title) w.set(t, (w.get(t) || 0) + this.titleBoost);
        docTermW[d] = w;
        for (const t of w.keys()) df.set(t, (df.get(t) || 0) + 1);
      }

      let total = 0;
      for (let d = 0; d < N; d++) total += this.docLen[d];
      this.avgdl = total / Math.max(N, 1);
      this.df = df;

      // postings + idf
      const postings = new Map();
      const idf = new Map();
      for (let d = 0; d < N; d++) {
        for (const [t, wt] of docTermW[d]) {
          let p = postings.get(t);
          if (!p) postings.set(t, (p = []));
          p.push([d, wt]);
        }
      }
      for (const [t, n] of df) idf.set(t, Math.log(1 + (N - n + 0.5) / (n + 0.5)));
      this.postings = postings;
      this.idf = idf;

      // sorted vocab + first-char buckets (prefix / fuzzy)
      this.vocab = [...df.keys()].sort();
      this.firstChar = new Map();
      for (const t of this.vocab) {
        const c = t[0];
        let a = this.firstChar.get(c);
        if (!a) this.firstChar.set(c, (a = []));
        a.push(t);
      }

      // symmetric synonym map (folded token -> Set of folded synonyms)
      this.synonyms = new Map();
      for (const grp of SYN_GROUPS) {
        for (const a of grp) {
          let set = this.synonyms.get(a);
          if (!set) this.synonyms.set(a, (set = new Set()));
          for (const b of grp) if (b !== a) set.add(b);
        }
      }

      this.stats = {
        slides: N,
        vocab: this.vocab.length,
        avgdl: +this.avgdl.toFixed(1),
        buildMs: +(now() - t0).toFixed(2),
      };
    }

    // first index in vocab with vocab[i] >= p
    _lowerBound(p) {
      let lo = 0, hi = this.vocab.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (this.vocab[mid] < p) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    }
    _prefix(p, cap) {
      const out = [];
      let i = this._lowerBound(p);
      while (i < this.vocab.length && this.vocab[i].startsWith(p)) {
        out.push(this.vocab[i]);
        i++;
      }
      if (out.length > cap) {
        out.sort((a, b) => (this.df.get(b) || 0) - (this.df.get(a) || 0));
        out.length = cap;
      }
      return out;
    }
    _fuzzy(p, cap = 6) {
      if (p.length < 4) return [];
      const bucket = this.firstChar.get(p[0]) || [];
      const out = [];
      for (const t of bucket) {
        if (Math.abs(t.length - p.length) > 1) continue;
        if (t === p) continue;
        if (withinEdit(p, t, 1)) out.push(t);
        if (out.length >= cap) break;
      }
      return out;
    }

    /* Compile a query into candidate index-terms (with weights) per token. */
    compile(query) {
      let toks = [];
      for (const t of tokensWithPos(query)) {
        if (t.folded.length >= 2 && !STOP.has(t.folded)) toks.push(t.folded);
      }
      const uniq = [...new Set(toks)].slice(0, 31); // bitmask coverage cap
      const perToken = [];
      const hitSet = new Set();
      const term2qi = new Map();

      uniq.forEach((qf, qi) => {
        const terms = new Map();
        const add = (term, w) => {
          if (!this.df.has(term)) return;
          terms.set(term, Math.max(terms.get(term) || 0, w));
        };
        add(qf, 1.0); // exact
        const st = lightStem(qf);
        if (st !== qf) add(st, 0.72); // stem
        if (qf.length >= 4) for (const t of this._prefix(qf, this.prefixCap)) add(t, t === qf ? 1.0 : 0.5);
        if (st !== qf && st.length >= 4) for (const t of this._prefix(st, 10)) add(t, 0.42);
        const syn = this.synonyms.get(qf);
        if (syn) for (const s of syn) add(s, 0.65);
        if (terms.size === 0) for (const t of this._fuzzy(qf)) add(t, 0.32); // typo fallback

        perToken.push({ qi, terms });
        for (const t of terms.keys()) {
          hitSet.add(t);
          let s = term2qi.get(t);
          if (!s) term2qi.set(t, (s = new Set()));
          s.add(qi);
        }
      });

      return { raw: query, tokens: uniq, perToken, hitSet, term2qi, n: uniq.length };
    }

    _proximity(docId, cq) {
      if (cq.n < 2) return 0;
      const toks = this.docTokens[docId];
      const hits = [];
      for (let i = 0; i < toks.length; i++) {
        const qis = cq.term2qi.get(toks[i]);
        if (qis) hits.push([i, qis]);
      }
      if (hits.length < 2) return 0;
      let bestDistinct = 1, bestSpan = Infinity;
      for (let i = 0; i < hits.length; i++) {
        const seen = new Set();
        for (let j = i; j < hits.length; j++) {
          for (const q of hits[j][1]) seen.add(q);
          const span = hits[j][0] - hits[i][0];
          if (seen.size > bestDistinct || (seen.size === bestDistinct && span < bestSpan)) {
            bestDistinct = seen.size;
            bestSpan = span;
          }
        }
      }
      if (bestDistinct < 2) return 0;
      return this.proximityWeight * (bestDistinct / cq.n) * (1 / (1 + bestSpan / 8));
    }

    search(query, opts = {}) {
      const limit = opts.limit ?? 40;
      const t0 = now();
      const cq = this.compile(query);
      if (cq.n === 0) return { ms: 0, total: 0, results: [], query, compiled: cq };

      const N = this.N;
      const score = new Float64Array(N);
      const mask = new Int32Array(N);

      for (const { qi, terms } of cq.perToken) {
        // Per query token, sum contributions from its variant terms (exact,
        // stem, prefix, synonym) but cap at 1.8x the single best term so one
        // rare repeated word can't dominate a genuine multi-variant match.
        const tmpSum = new Map();
        const tmpMax = new Map();
        for (const [term, w] of terms) {
          const idf = this.idf.get(term) || 0;
          const post = this.postings.get(term);
          if (!post) continue;
          for (let i = 0; i < post.length; i++) {
            const d = post[i][0], f = post[i][1];
            const dl = this.docLen[d];
            const s = (w * idf * (f * (this.k1 + 1))) / (f + this.k1 * (1 - this.b + (this.b * dl) / this.avgdl));
            tmpSum.set(d, (tmpSum.get(d) || 0) + s);
            if (s > (tmpMax.get(d) || 0)) tmpMax.set(d, s);
          }
        }
        for (const [d, sum] of tmpSum) {
          score[d] += Math.min(sum, tmpMax.get(d) * 1.8);
          mask[d] |= 1 << qi;
        }
      }

      let cands = [];
      for (let d = 0; d < N; d++) {
        if (score[d] > 0) {
          const cov = popcount(mask[d]) / cq.n;
          cands.push([d, score[d] * (1 - this.coverageWeight + this.coverageWeight * cov), cov]);
        }
      }
      cands.sort((a, b) => b[1] - a[1]);

      const K = Math.min(cands.length, this.rerankK);
      for (let i = 0; i < K; i++) cands[i][1] *= 1 + this._proximity(cands[i][0], cq);
      cands.sort((a, b) => b[1] - a[1]);

      const top = cands.slice(0, limit);
      const max = top.length ? top[0][1] : 1;
      const results = top.map(([d, sc, cov]) => {
        const s = this.slides[d];
        return {
          docId: d,
          page: s.page,
          lecture: s.lecture,
          lectureNum: s.lectureNum,
          title: s.title,
          score: sc,
          norm: max > 0 ? sc / max : 0,
          coverage: cov,
          snippet: this.snippet(s.text, cq),
        };
      });
      return { ms: now() - t0, total: cands.length, results, query, compiled: cq };
    }

    /* Best-window plain-text snippet around the densest cluster of hits. */
    snippet(text, cqOrQuery, maxLen = 230) {
      if (!text) return "";
      const cq = typeof cqOrQuery === "string" ? this.compile(cqOrQuery) : cqOrQuery;
      const toks = tokensWithPos(text);
      const hitPos = [];
      for (const t of toks) if (cq.hitSet.has(t.folded)) hitPos.push(t.start);
      if (hitPos.length === 0) {
        const cut = text.slice(0, maxLen);
        return cut + (text.length > maxLen ? "…" : "");
      }
      let best = hitPos[0], bestCount = 0;
      for (const p of hitPos) {
        let c = 0;
        for (const q of hitPos) if (q >= p && q <= p + maxLen) c++;
        if (c > bestCount) { bestCount = c; best = p; }
      }
      let start = Math.max(0, best - 36);
      let end = Math.min(text.length, start + maxLen);
      let snip = text.slice(start, end).trim();
      return (start > 0 ? "…" : "") + snip + (end < text.length ? "…" : "");
    }

    /* HTML-escaped text with <mark> around every matching word. */
    highlightHTML(text, cqOrQuery) {
      if (!text) return "";
      const cq = typeof cqOrQuery === "string" ? this.compile(cqOrQuery) : cqOrQuery;
      let out = "", last = 0;
      for (const tk of tokensWithPos(text)) {
        out += escHtml(text.slice(last, tk.start));
        const w = escHtml(text.slice(tk.start, tk.end));
        out += cq.hitSet.has(tk.folded) ? "<mark>" + w + "</mark>" : w;
        last = tk.end;
      }
      out += escHtml(text.slice(last));
      return out;
    }
  }

  // expose helpers for tests / reuse
  SlideSearchEngine.fold = fold;
  SlideSearchEngine.contentTokens = contentTokens;
  return SlideSearchEngine;
});
