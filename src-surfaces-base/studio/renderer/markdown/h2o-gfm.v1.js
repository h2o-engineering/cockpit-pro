// @version 0.1.0-m03-p2-s1
"use strict";

/*
 * H2O bounded formal-GFM closure for markdown-it (M03 P2 S2A T4 S1).
 *
 * Grammar only. This module owns exactly two formal-GFM behaviours that
 * markdown-it 15.0.1 does not provide at the formal base:
 *
 *   - extended autolink literals (GFM 6.9), installed into the engine's own
 *      core slot so linkify-it stays off and there is no source
 *     pre-parser and no post-IR URL scanner;
 *   - strikethrough run semantics, replacing only the engine's delimiter gate
 *     while reusing its delimiter scanning and pairing.
 *
 * Provenance: the extended-autolink algorithm is written against the GFM
 * specification and the frozen formal vectors. The token-walk/replacement
 * skeleton follows markdown-it's documented core-rule plugin pattern. No
 * third-party implementation code is copied.
 *
 * This file has no dependencies, touches no DOM, performs no sanitization and
 * makes no URL security decision. Destinations are carried as inert data; the
 * S2B sink is the sole navigation/admission authority.
 *
 * One semantic source serves both surfaces: it publishes onto the H2O global
 * for the Studio classic-script environment and, where a module system exists,
 * exports the same functions for Metro/Node. There is no second copy.
 */
(function (global) {
  const H2O = global.H2O = global.H2O || {};
  const Studio = H2O.Studio = H2O.Studio || {};
  const Renderer = Studio.Renderer = Studio.Renderer || {};

  /* ---------- character classes (GFM §6.9) ---------- */
  const isAlnum = c => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
  const isDomainCh = c => isAlnum(c) || c === 45 || c === 95 || c > 127;   // - _ and non-ASCII
  const isAtextCh = c => isAlnum(c) || c === 46 || c === 45 || c === 95 || c === 43; // . - _ +
  // GFM §6.9: a `www.` autolink may start at line start, after whitespace, or after * _ ~ (
  const isWwwBoundary = c => c === undefined || c === 32 || c === 9 || c === 10 ||
    c === 42 || c === 95 || c === 126 || c === 40;
  // A scheme autolink only requires that the preceding character is not an ASCII letter
  // (formal vectors link `"http://google.com"` and `'http://google.com'`).
  const isSchemeBoundary = c => c === undefined ||
    !((c >= 65 && c <= 90) || (c >= 97 && c <= 122));
  const TRAIL = '?!.,:*_~';

  /* ---------- shared trailing rules (GFM §6.9 "extended autolink path validation") ---------- */
  function trimTrailing(s) {
    let end = s.length;
    for (;;) {
      const before = end;
      while (end > 0 && TRAIL.includes(s[end - 1])) end--;
      if (end > 0 && s[end - 1] === ')') {
        let open = 0, close = 0;
        for (let i = 0; i < end; i++) { if (s[i] === '(') open++; else if (s[i] === ')') close++; }
        while (close > open && end > 0 && s[end - 1] === ')') { close--; end--; }
      }
      if (end > 0 && s[end - 1] === ';') {                 // entity-like ending
        let i = end - 1;
        while (i > 0 && isAlnum(s.charCodeAt(i - 1))) i--;
        if (i > 0 && s[i - 1] === '&') end = i - 1;
      }
      if (end === before) break;
    }
    return s.slice(0, end);
  }
  // GFM: the autolink path ends at whitespace, `<`, or a quote character
  // (formal vectors keep the closing `"` / `'` of "http://google.com" outside the link).
  const PATH_END = /[\s<"'`]/;
  function cutAtEnd(s) { const m = PATH_END.exec(s); return m ? s.slice(0, m.index) : s; }

  /* ---------- domain validation (GFM §6.9) ---------- */
  function validDomain(d, { requireDot = true, lastTwoNoUnderscore = false } = {}) {
    if (!d) return false;
    const parts = d.split('.');
    if (requireDot && parts.length < 2) return false;
    if (parts.some(p => p.length === 0)) return false;
    if (lastTwoNoUnderscore) {
      for (const p of parts.slice(-2)) if (p.includes('_')) return false;
    }
    return true;
  }

  /* ---------- scanners ---------- */
  // www. / http:// / https:// literal starting at `i`
  function scanUrl(text, i) {
    const prev = i === 0 ? undefined : text.charCodeAt(i - 1);
    const rest = text.slice(i);
    const m = /^(?:(https?:\/\/)|(www\.))/i.exec(rest);
    if (!m) return null;
    if (!(m[2] ? isWwwBoundary(prev) : isSchemeBoundary(prev))) return null;
    const schemeLen = m[0].length;
    let j = i + schemeLen;
    let dStart = j;
    while (j < text.length && (isDomainCh(text.charCodeAt(j)) || text.charCodeAt(j) === 46)) j++;
    const domain = text.slice(dStart, j);
    // Only `www.` literals must look like a dotted host; `http://inlines` is a formal vector.
    if (!validDomain(domain, { requireDot: !!m[2], lastTwoNoUnderscore: true })) return null;
    while (j < text.length && !PATH_END.test(text[j])) j++;   // path: to a terminator
    let raw = cutAtEnd(text.slice(i, j));
    raw = trimTrailing(raw);
    if (raw.length <= schemeLen) return null;
    const url = m[2] ? 'http://' + raw : raw;
    return { index: i, lastIndex: i + raw.length, url, text: raw };
  }

  // email literal anchored at an `@` at `at`; walks back over atext (cmark-gfm order)
  function scanEmail(text, at) {
    let s = at;
    while (s > 0 && isAtextCh(text.charCodeAt(s - 1))) s--;
    const local = text.slice(s, at);
    if (!local || local.endsWith('.') === false && false) return null;
    if (!local) return null;
    let j = at + 1, dStart = j;
    while (j < text.length && (isDomainCh(text.charCodeAt(j)) || text.charCodeAt(j) === 46)) j++;
    let domain = text.slice(dStart, j);
    while (domain.length && (domain.endsWith('.') || domain.endsWith('-') || domain.endsWith('_'))) {
      domain = domain.slice(0, -1); j--;
    }
    if (!validDomain(domain, { requireDot: true, lastTwoNoUnderscore: true })) return null;
    if (!isAlnum(domain.charCodeAt(domain.length - 1))) return null;
    // optional formal protocol prefix immediately before the local part
    let index = s, url = 'mailto:' + local + '@' + domain, visible = local + '@' + domain, scheme = null;
    const pm = /(mailto:|xmpp:)$/i.exec(text.slice(0, s));
    if (pm) {
      const pStart = s - pm[1].length;
      const prevCh = pStart === 0 ? undefined : text.charCodeAt(pStart - 1);
      if (prevCh === undefined || !isAlnum(prevCh)) {
        scheme = pm[1].toLowerCase().slice(0, -1);
        index = pStart;
        visible = text.slice(pStart, j);
        url = visible;
      }
    }
    let lastIndex = index + visible.length;
    if (scheme === 'xmpp' && text[lastIndex] === '/') {       // xmpp resource
      let k = lastIndex + 1;
      while (k < text.length && !PATH_END.test(text[k])) k++;
      let withRes = trimTrailing(cutAtEnd(text.slice(index, k)));
      if (withRes.length > visible.length) { visible = withRes; url = withRes; lastIndex = index + withRes.length; }
    }
    return { index, lastIndex, url, text: visible };
  }

  /** Find every formal-GFM extended autolink in `text`, left to right, non-overlapping. */
  function findGfmAutolinks(text) {
    const out = []; let i = 0;
    while (i < text.length) {
      const c = text.charCodeAt(i);
      let hit = null;
      if (c === 104 || c === 72 || c === 119 || c === 87) hit = scanUrl(text, i);   // h H w W
      if (!hit && c === 64) hit = scanEmail(text, i);                               // @
      if (hit && hit.lastIndex > hit.index && hit.index >= (out.length ? out[out.length - 1].lastIndex : 0)) {
        out.push(hit); i = hit.lastIndex; continue;
      }
      i++;
    }
    return out;
  }

  /* GFM href encoding. markdown-it's own `normalizeLink` (mdurl + punycode) rewrites a
   * non-ASCII host to `xn--…`, while the formal vectors require percent-encoded UTF-8, so
   * the closure encodes autolink destinations itself and does not call `normalizeLink`. */
  function gfmEncodeUrl(url) {
    try { return encodeURI(url).replace(/%25([0-9A-Fa-f]{2})/g, '%$1'); }
    catch (_) { return url; }
  }

  /* ---------- markdown-it installation ---------- */
  function h2oGfm(md, opts = {}) {
    const singleTilde = opts.singleTilde !== false;

    /* --- extended autolinks: own the core `linkify` slot (linkify-it stays off) --- */
    md.core.ruler.at('linkify', function h2oGfmAutolink(state) {
      for (const blockToken of state.tokens) {
        if (blockToken.type !== 'inline') continue;
        let tokens = blockToken.children;
        for (let i = tokens.length - 1; i >= 0; i--) {
          const cur = tokens[i];
          if (!cur) continue;
          if (cur.type === 'link_close') {                       // skip inside explicit links
            i--;
            while (i >= 0 && tokens[i].type !== 'link_open' && tokens[i].level !== cur.level) i--;
            continue;
          }
          if (cur.type !== 'text') continue;
          let links = findGfmAutolinks(cur.content);
          if (!links.length) continue;
          if (links[0].index === 0 && i > 0 && tokens[i - 1].type === 'text_special') links = links.slice(1);
          if (!links.length) continue;
          const nodes = []; let level = cur.level, lastPos = 0;
          for (const l of links) {
            if (l.index > lastPos) {
              const t = new state.Token('text', '', 0);
              t.content = cur.content.slice(lastPos, l.index); t.level = level; nodes.push(t);
            }
            const o = new state.Token('link_open', 'a', 1);
            o.attrs = [['href', gfmEncodeUrl(l.url)]]; o.level = level++; o.markup = 'h2o-gfm'; o.info = 'auto';
            const t = new state.Token('text', '', 0); t.content = l.text; t.level = level;
            const c = new state.Token('link_close', 'a', -1); c.level = --level; c.markup = 'h2o-gfm'; c.info = 'auto';
            nodes.push(o, t, c);
            lastPos = l.lastIndex;
          }
          if (lastPos < cur.content.length) {
            const t = new state.Token('text', '', 0);
            t.content = cur.content.slice(lastPos); t.level = level; nodes.push(t);
          }
          blockToken.children = tokens = tokens.slice(0, i).concat(nodes, tokens.slice(i + 1));
        }
      }
    });

    /* --- strikethrough: reuse markdown-it's delimiter machinery, change only the run gate --- */
    // GFM requires an opener and closer of EQUAL run length (`~mismatch~~` is literal).
    // markdown-it's `balance_pairs` only applies the mod-3 emphasis rule, so the pairs it
    // produces are filtered here; pairing itself is still the engine's.
    function convert(state, delimiters) {
      for (const start of delimiters) {
        if (start.marker !== 126 || start.end === -1) continue;
        const end = delimiters[start.end];
        if (start.h2oRun !== end.h2oRun) continue;          // mismatched run lengths stay literal
        const mark = '~'.repeat(start.h2oRun);
        const o = state.tokens[start.token];
        o.type = 's_open'; o.tag = 's'; o.nesting = 1; o.markup = mark; o.content = '';
        const c = state.tokens[end.token];
        c.type = 's_close'; c.tag = 's'; c.nesting = -1; c.markup = mark; c.content = '';
      }
    }
    md.inline.ruler.at('strikethrough', function h2oStrike(state, silent) {
      const start = state.pos;
      if (state.src.charCodeAt(start) !== 126) return false;
      if (silent) return false;
      const scanned = state.scanDelims(state.pos, true);
      let len = scanned.length;
      // GFM: a run of three or more tildes is never strikethrough. It must be CONSUMED as
      // literal text — returning false lets the tokenizer retry one character later, where a
      // 2-tilde sub-run would then pair (`~~~~~one~~~~~` -> `~~~<del>one~~~</del>`).
      if (len >= 3) {
        const lit = state.push('text', '', 0);
        lit.content = '~'.repeat(len);
        state.pos += len;
        return true;
      }
      if (!singleTilde && len < 2) return false;        // provider profile: double-tilde only
      // One delimiter per RUN (not per character), mirroring upstream's pairing contract:
      // upstream emits one delimiter per `~~`, so emitting one per character would make
      // `~~x~~` pair twice and nest as <s><s>x</s></s>.
      const token = state.push('text', '', 0);
      token.content = '~'.repeat(len);
      state.delimiters.push({ marker: 126, length: 0, token: state.tokens.length - 1,
        end: -1, open: scanned.can_open, close: scanned.can_close, h2oRun: len });
      state.pos += len;
      return true;
    });
    md.inline.ruler2.at('strikethrough', function h2oStrikePost(state) {
      convert(state, state.delimiters);
      for (const meta of state.tokens_meta) if (meta && meta.delimiters) convert(state, meta.delimiters);
    });
  }
  const api = Object.freeze({
    __version: "0.1.0-m03-p2-s1",
    findGfmAutolinks,
    gfmEncodeUrl,
    h2oGfm,
  });

  Renderer.markdownGfm = api;
  if (typeof module === "object" && module && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
