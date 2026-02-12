(() => {
  // Keep the guard in extension world only (not on page window), so reloads
  // can reinstall the listener cleanly on already-open tabs.
  if (globalThis.__HiddenTextDetectorInstalled) return;
  globalThis.__HiddenTextDetectorInstalled = true;

  const HIGHLIGHT_CLASS = "htd-highlight-outline";
  const TARGET_HIGHLIGHT_CLASS = "htd-target-outline";
  const PANEL_ID = "htd-panel";
  const STYLE_ID = "htd-style";
  const ATTR_MARK = "data-htd-mark";

  // Safety limits (avoid freezing huge pages)
  const MAX_TEXT_NODES = 60000;
  const MAX_PSEUDO_ELEMENTS = 60000;
  const MAX_ROOT_DISCOVERY_ELEMENTS = 60000;
  const MAX_RESULTS = 800;
  const TOLERANCE_THRESHOLDS = {
    everything: -999,
    sweep: 2,
    default: 6,
    precise: 9,
  };

  const ZERO_WIDTH_RE = /[\u200B\u200C\u200D\u2060\uFEFF]/g; // ZWSP/ZWNJ/ZWJ/word-joiner/BOM
  const BIDI_RE = /[\u202A-\u202E\u2066-\u2069]/g; // LRE/RLE/PDF/LRO/RLO + isolate controls

  function injectStylesOnce() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .${HIGHLIGHT_CLASS} { outline: 3px solid #ff3b30 !important; outline-offset: 2px !important; }
      .${TARGET_HIGHLIGHT_CLASS} { outline: 3px solid #2563eb !important; outline-offset: 2px !important; }
      #${PANEL_ID} {
        position: fixed; right: 12px; bottom: 12px; z-index: 2147483647;
        width: 380px; max-height: 52vh; overflow: hidden;
        display: flex; flex-direction: column;
        background: rgba(20,20,20,0.95); color: #fff; border-radius: 10px;
        box-shadow: 0 10px 30px rgba(0,0,0,0.4);
        font: 12px/1.35 system-ui, -apple-system, Segoe UI, Roboto, Arial;
      }
      #${PANEL_ID} .htd-header {
        display:flex; align-items:center; justify-content:space-between;
        gap: 8px;
        padding: 10px 12px; border-bottom: 1px solid rgba(255,255,255,0.15);
        position: relative;
        background: rgba(20,20,20,0.98);
        z-index: 1;
      }
      #${PANEL_ID} .htd-title {
        font-weight: 700;
        flex: 1 1 auto;
        min-width: 0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      #${PANEL_ID} button {
        background: rgba(255,255,255,0.12); color:#fff; border: 0; padding: 6px 8px;
        border-radius: 8px; cursor: pointer;
      }
      #${PANEL_ID} .htd-list { overflow: auto; flex: 1 1 auto; min-height: 0; }
      #${PANEL_ID} .htd-item { padding: 10px 12px; border-bottom: 1px solid rgba(255,255,255,0.08); }
      #${PANEL_ID} .htd-item:hover { background: rgba(255,255,255,0.06); }
      #${PANEL_ID} .htd-item:focus { outline: 2px solid #60a5fa; outline-offset: -2px; }
      #${PANEL_ID} .htd-reasons { opacity: 0.9; margin-top: 6px; }
      #${PANEL_ID} .htd-reason-list {
        margin: 6px 0 0 18px;
        padding: 0;
      }
      #${PANEL_ID} .htd-reason-item {
        margin: 4px 0;
      }
      #${PANEL_ID} .htd-reason-chip {
        display: inline-block;
        color: #f3f4f6;
        background: #1f2937;
        border: 1px solid #374151;
        border-radius: 8px;
        padding: 2px 8px;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 11px;
      }
      #${PANEL_ID} .htd-snippet { margin-top: 6px; opacity: 0.95; }
      #${PANEL_ID} .htd-meta { margin-top: 6px; opacity: 0.75; font-size: 11px; }
      #${PANEL_ID} .htd-score-chip {
        display: inline-block;
        color: #ffffff;
        background: #0f172a;
        border: 1px solid #334155;
        border-radius: 999px;
        padding: 2px 8px;
        font-weight: 700;
      }
      #${PANEL_ID} .htd-actions { display:flex; gap:8px; flex: 0 0 auto; }
      #${PANEL_ID} code { color: #93c5fd; }
      #${PANEL_ID} .htd-note { padding: 10px 12px; opacity: 0.85; }
      .${HIGHLIGHT_CLASS}.htd-jump-pulse {
        box-shadow: 0 0 0 4px rgba(251, 191, 36, 0.45) !important;
      }
      .${TARGET_HIGHLIGHT_CLASS}.htd-jump-pulse {
        box-shadow: 0 0 0 4px rgba(96, 165, 250, 0.45) !important;
      }
    `;
    document.documentElement.appendChild(style);
  }

  function escapeHtml(s) {
    return String(s)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function clamp(n, min, max) {
    return Math.min(max, Math.max(min, n));
  }

  function parseCssByte(raw) {
    if (!raw) return 0;
    const s = String(raw).trim();
    if (s.endsWith("%")) {
      const pct = Number(s.slice(0, -1));
      if (!Number.isFinite(pct)) return 0;
      return clamp(Math.round((pct / 100) * 255), 0, 255);
    }
    const n = Number(s);
    return Number.isFinite(n) ? clamp(Math.round(n), 0, 255) : 0;
  }

  function parseCssAlpha(raw) {
    if (!raw) return 1;
    const s = String(raw).trim();
    if (s.endsWith("%")) {
      const pct = Number(s.slice(0, -1));
      if (!Number.isFinite(pct)) return 1;
      return clamp(pct / 100, 0, 1);
    }
    const n = Number(s);
    return Number.isFinite(n) ? clamp(n, 0, 1) : 1;
  }

  function parseRGBA(cssColor) {
    const color = String(cssColor || "").trim().toLowerCase();
    if (!color) return { r: 0, g: 0, b: 0, a: 1 };
    if (color === "transparent") return { r: 0, g: 0, b: 0, a: 0 };

    const hex = color.match(/^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
    if (hex) {
      let v = hex[1];
      if (v.length === 3 || v.length === 4) v = [...v].map(ch => ch + ch).join("");
      const hasAlpha = v.length === 8;
      const r = parseInt(v.slice(0, 2), 16);
      const g = parseInt(v.slice(2, 4), 16);
      const b = parseInt(v.slice(4, 6), 16);
      const a = hasAlpha ? parseInt(v.slice(6, 8), 16) / 255 : 1;
      return { r, g, b, a: clamp(a, 0, 1) };
    }

    const m = color.match(/^rgba?\((.+)\)$/i);
    if (!m) return { r: 0, g: 0, b: 0, a: 1 };

    let body = m[1].trim();
    let alpha = 1;

    if (body.includes("/")) {
      const [rgbPart, alphaPart] = body.split("/", 2);
      body = rgbPart.trim();
      alpha = parseCssAlpha(alphaPart.trim());
    }

    const parts = body.includes(",")
      ? body.split(",").map(s => s.trim())
      : body.split(/\s+/).filter(Boolean);

    if (parts.length < 3) return { r: 0, g: 0, b: 0, a: 1 };

    const r = parseCssByte(parts[0]);
    const g = parseCssByte(parts[1]);
    const b = parseCssByte(parts[2]);
    if (parts.length >= 4) alpha = parseCssAlpha(parts[3]);
    return { r, g, b, a: alpha };
  }

  // WCAG-ish contrast ratio (ignores alpha blending complexities)
  function relLuminance({ r, g, b }) {
    const srgb = [r, g, b].map(v => v / 255).map(c =>
      c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
    );
    return 0.2126 * srgb[0] + 0.7152 * srgb[1] + 0.0722 * srgb[2];
  }
  function contrastRatio(fg, bg) {
    const L1 = relLuminance(fg);
    const L2 = relLuminance(bg);
    const hi = Math.max(L1, L2);
    const lo = Math.min(L1, L2);
    return (hi + 0.05) / (lo + 0.05);
  }

  function getEffectiveBackgroundColor(el) {
    let cur = el;
    while (cur && cur.nodeType === 1) {
      const bg = parseRGBA(getComputedStyle(cur).backgroundColor);
      if (bg.a > 0.05) return bg;
      cur = cur.parentElement;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  }

  function cssPath(el) {
    if (!el || el.nodeType !== 1) return "";
    if (el.id) return `#${CSS.escape(el.id)}`;
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && parts.length < 7) {
      let part = cur.tagName.toLowerCase();
      if (cur.classList?.length) {
        part += "." + [...cur.classList].slice(0, 2).map(c => CSS.escape(c)).join(".");
      }
      const parent = cur.parentElement;
      if (!parent) break;
      const siblings = [...parent.children].filter(x => x.tagName === cur.tagName);
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(cur) + 1})`;
      parts.unshift(part);
      cur = parent;
      if (cur?.id) { parts.unshift(`#${CSS.escape(cur.id)}`); break; }
    }
    return parts.join(" > ");
  }

  function hasHiddenAncestor(el) {
    let cur = el;
    while (cur && cur.nodeType === 1) {
      const cs = getComputedStyle(cur);
      if (cs.display === "none") return "ancestor display:none";
      if (cs.visibility === "hidden" || cs.visibility === "collapse") return `ancestor visibility:${cs.visibility}`;
      const op = parseFloat(cs.opacity || "1");
      if (op <= 0.02) return `ancestor opacity:${op}`;
      // content-visibility (Chrome)
      if (cs.contentVisibility === "hidden") return "ancestor content-visibility:hidden";
      cur = cur.parentElement;
    }
    return null;
  }

  function isOccluded(el) {
    // Very rough: sample the center of the element if it’s in viewport
    const rect = el.getBoundingClientRect();
    if (rect.width < 3 || rect.height < 3) return null;

    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) return null;

    const topEl = document.elementFromPoint(cx, cy);
    if (!topEl) return null;
    if (topEl === el || el.contains(topEl) || topEl.contains(el)) return null;

    return "covered by another element (occlusion)";
  }

  function getOffCanvasReason(rect, cs) {
    const H_MARGIN = 200;
    const farLeftOrRight = rect.right < -H_MARGIN || rect.left > innerWidth + H_MARGIN;
    if (!farLeftOrRight) return null;

    const isPositioned = cs.position === "absolute" || cs.position === "fixed";
    const left = parseFloat(cs.left || "");
    const right = parseFloat(cs.right || "");
    const hasExtremeOffsets =
      (Number.isFinite(left) && Math.abs(left) >= 300) ||
      (Number.isFinite(right) && Math.abs(right) >= 300);
    const hasTranslate = cs.transform && cs.transform !== "none" && /translate|matrix/i.test(cs.transform);

    if (!isPositioned && !hasExtremeOffsets && !hasTranslate) return null;
    return "off-canvas positioning";
  }

  function normalizeText(t) {
    return t.replace(/\s+/g, " ").trim();
  }

  function normalizeTolerance(raw) {
    const val = String(raw || "").toLowerCase();
    const migrated =
      val === "all" ? "everything" :
      val === "strict" ? "sweep" :
      val === "balanced" ? "default" :
      val;
    return Object.prototype.hasOwnProperty.call(TOLERANCE_THRESHOLDS, migrated) ? migrated : "default";
  }

  function reasonWeight(reason) {
    if (reason.startsWith("contains zero-width chars")) return 8;
    if (reason.startsWith("contains bidi control chars")) return 8;
    if (reason.startsWith("tiny font-size")) return 6;
    if (reason.startsWith("text color alpha low")) return 6;
    if (reason.startsWith("-webkit-text-fill-color alpha low")) return 6;
    if (reason === "-webkit-text-fill-color: transparent") return 6;
    if (reason === "color: transparent") return 6;
    if (reason.startsWith("very low contrast")) return 5;
    if (reason === "line-height:0") return 4;
    if (reason.startsWith("letter-spacing very negative")) return 4;
    if (reason.startsWith("text-indent very negative")) return 4;
    if (reason === "off-canvas positioning") return 4;
    if (reason.startsWith("transform scales to ~0")) return 3;
    if (reason.startsWith("opacity:0")) return 3;
    if (reason.startsWith("clip-path:")) return 3;
    if (reason === "mask-image applied") return 2;
    if (reason.startsWith("clip:")) return 2;
    if (reason.startsWith("display:")) return 1;
    if (reason.startsWith("visibility:")) return 1;
    if (reason.startsWith("ancestor display:")) return 1;
    if (reason.startsWith("ancestor visibility:")) return 1;
    if (reason.startsWith("ancestor opacity:")) return 1;
    if (reason === "content-visibility:hidden") return 1;
    if (reason === "ancestor content-visibility:hidden") return 1;
    if (reason.startsWith("small + overflow:hidden")) return 1;
    if (reason.startsWith("transform + nearly zero box")) return 1;
    if (reason.startsWith("nearly zero box")) return 1;
    if (reason.startsWith("covered by another element")) return 0;
    if (reason.endsWith("content")) return 0;
    return 1;
  }

  function hasHighSignalReason(reasons) {
    return reasons.some(reason =>
      reason.startsWith("contains zero-width chars") ||
      reason.startsWith("contains bidi control chars") ||
      reason.startsWith("tiny font-size") ||
      reason.startsWith("text color alpha low") ||
      reason.startsWith("-webkit-text-fill-color alpha low") ||
      reason === "-webkit-text-fill-color: transparent" ||
      reason === "color: transparent" ||
      reason.startsWith("very low contrast") ||
      reason === "line-height:0" ||
      reason.startsWith("letter-spacing very negative") ||
      reason.startsWith("text-indent very negative") ||
      reason === "off-canvas positioning" ||
      reason.startsWith("transform scales to ~0")
    );
  }

  function isLikelyIconGlyph(text) {
    const s = String(text || "").trim();
    if (!s || s.length > 4) return false;
    return /^[\uE000-\uF8FF]+$/u.test(s);
  }

  function isLikelyA11yElement(el, snippet, reasons) {
    if (!el || el.nodeType !== 1) return false;
    const className = typeof el.className === "string" ? el.className : "";
    const haystack = `${el.id || ""} ${className}`.toLowerCase();
    const text = String(snippet || "").trim().toLowerCase();

    if (/screenreader|sr-only|visually-hidden|skip_navigation|a11y|accessibility|external_link_icon/.test(haystack)) {
      return true;
    }
    if (text === "links to an external site.") return true;

    const onlyLowSignal = reasons.length > 0 && reasons.every(r => reasonWeight(r) <= 1);
    if (!onlyLowSignal) return false;

    const hasClipping = reasons.some(r => r.startsWith("small + overflow:hidden") || r.startsWith("clip:"));
    const hasHiddenAncestor = reasons.some(r => r.startsWith("ancestor display:") || r.startsWith("ancestor visibility:"));
    return hasClipping || hasHiddenAncestor;
  }

  function scoreFinding(item) {
    let score = 0;
    for (const reason of item.reasons) {
      score += reasonWeight(reason);
    }

    if (item.snippet.length >= 24) score += 1;
    if (item.source.includes("::")) score -= 1;
    if (isLikelyIconGlyph(item.snippet)) score -= 3;
    if (/\b(ignore|instruction|prompt|must|do not)\b/i.test(item.snippet)) score += 2;

    return score;
  }

  function shouldKeepFinding(item, tolerance) {
    const highSignal = hasHighSignalReason(item.reasons);
    const likelyA11y = isLikelyA11yElement(item.el, item.snippet, item.reasons);
    const sourceHasPseudo = item.source.includes("::before") || item.source.includes("::after");
    const onlyLowSignal = item.reasons.length > 0 && item.reasons.every(r => reasonWeight(r) <= 1);
    const score = item.score;

    if (sourceHasPseudo && isLikelyIconGlyph(item.snippet) && !highSignal) return false;
    if (likelyA11y && !highSignal) return false;
    if (onlyLowSignal && !highSignal) return false;

    const minScore = TOLERANCE_THRESHOLDS[tolerance] || TOLERANCE_THRESHOLDS.default;
    if (tolerance === "sweep") return score >= minScore || highSignal;
    if (tolerance === "precise") return score >= minScore && highSignal;
    return score >= minScore || (highSignal && score >= minScore - 1);
  }

  function filterAndRankResults(items, tolerance, notes) {
    const normalizedTolerance = normalizeTolerance(tolerance);
    const scored = items.map(item => ({ ...item, score: scoreFinding(item) }));

    if (normalizedTolerance === "everything") {
      scored.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return b.reasons.length - a.reasons.length;
      });
      notes.push("Everything mode: filtering disabled.");
      return scored;
    }

    const kept = scored.filter(item => shouldKeepFinding(item, normalizedTolerance));
    const dropped = scored.length - kept.length;

    if (dropped > 0) {
      notes.push(`Filtered ${dropped} low-confidence result(s) using ${normalizedTolerance} tolerance.`);
    }

    kept.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.reasons.length - a.reasons.length;
    });

    return kept;
  }

  function createWalker(root, whatToShow, filter) {
    const ownerDoc =
      root?.nodeType === Node.DOCUMENT_NODE ? root : (root?.ownerDocument || document);
    const startNode = root?.body || root;
    return ownerDoc.createTreeWalker(startNode, whatToShow, filter || null);
  }

  function contentFromPseudo(el, pseudo) {
    const cs = getComputedStyle(el, pseudo);
    let c = cs.content;
    if (!c || c === "none" || c === "normal") return null;
    // Strip surrounding quotes (common for strings)
    if ((c.startsWith('"') && c.endsWith('"')) || (c.startsWith("'") && c.endsWith("'"))) {
      c = c.slice(1, -1);
    }
    c = normalizeText(c);
    return c ? { text: c, cs } : null;
  }

  function analyzeTextLike(el, cs, text) {
    const reasons = [];

    // Unicode stealth
    const zw = (text.match(ZERO_WIDTH_RE) || []).length;
    if (zw > 0) reasons.push(`contains zero-width chars (x${zw})`);
    const bidi = (text.match(BIDI_RE) || []).length;
    if (bidi > 0) reasons.push(`contains bidi control chars (x${bidi})`);

    // Base visibility
    if (cs.display === "none") reasons.push("display:none");
    if (cs.visibility === "hidden" || cs.visibility === "collapse") reasons.push(`visibility:${cs.visibility}`);
    const opacity = parseFloat(cs.opacity || "1");
    if (opacity <= 0.02) reasons.push(`opacity:${opacity}`);

    // content-visibility
    if (cs.contentVisibility === "hidden") reasons.push("content-visibility:hidden");

    // Size tricks
    const fontSizePx = parseFloat(cs.fontSize || "16");
    if (Number.isFinite(fontSizePx) && fontSizePx <= 4) reasons.push(`tiny font-size (${fontSizePx.toFixed(1)}px)`);

    const lineHeight = cs.lineHeight;
    if (lineHeight === "0px" || lineHeight === "0") reasons.push("line-height:0");

    const letterSpacing = parseFloat(cs.letterSpacing || "0");
    if (Number.isFinite(letterSpacing) && letterSpacing < -20) reasons.push(`letter-spacing very negative (${letterSpacing}px)`);

    const textIndent = parseFloat(cs.textIndent || "0");
    if (Number.isFinite(textIndent) && textIndent < -300) reasons.push(`text-indent very negative (${textIndent}px)`);

    // Color / fill tricks
    const fg = parseRGBA(cs.color);
    if (fg.a <= 0.08) reasons.push(`text color alpha low (${fg.a.toFixed(2)})`);

    // Some sites hide text via text-fill-color
    const tfill = cs.webkitTextFillColor || cs.getPropertyValue("-webkit-text-fill-color");
    if (tfill) {
      const tf = parseRGBA(tfill);
      if (tf.a <= 0.08) reasons.push(`-webkit-text-fill-color alpha low (${tf.a.toFixed(2)})`);
      if (tfill === "transparent") reasons.push("-webkit-text-fill-color: transparent");
    }

    if (cs.color === "transparent") reasons.push("color: transparent");

    const bg = getEffectiveBackgroundColor(el);
    const cr = contrastRatio(fg, bg);

    // Low contrast becomes more suspicious when text is smallish
    if (cr < 1.5 && fontSizePx <= 12) reasons.push(`very low contrast vs background (ratio ${cr.toFixed(2)})`);

    // Clipping/masking
    if (cs.overflow === "hidden" || cs.overflowX === "hidden" || cs.overflowY === "hidden") {
      // only flag if element is small (common sr-only / clipping)
      const rect = el.getBoundingClientRect();
      if (rect.width <= 20 || rect.height <= 12) reasons.push("small + overflow:hidden (clipping)");
    }

    const clip = cs.clip;
    if (clip && clip !== "auto") reasons.push(`clip:${clip}`);

    const clipPath = cs.clipPath;
    if (clipPath && clipPath !== "none") reasons.push(`clip-path:${clipPath}`);

    const maskImage = cs.maskImage || cs.webkitMaskImage;
    if (maskImage && maskImage !== "none") reasons.push("mask-image applied");

    // Transform shrink
    const tr = cs.transform;
    if (tr && tr !== "none") {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 2 || rect.height <= 2) reasons.push("transform + nearly zero box");
      if (/scale\(\s*0(\.0+)?/.test(tr) || /matrix\(\s*0[, ]/.test(tr)) reasons.push(`transform scales to ~0 (${tr})`);
      if (/translate/.test(tr)) {
        // If it ends up off-screen we’ll flag below
      }
    }

    // Off-screen
    const rect = el.getBoundingClientRect();
    const offscreenReason = getOffCanvasReason(rect, cs);
    const offscreen = Boolean(offscreenReason);
    if (offscreenReason) reasons.push(offscreenReason);

    // Nearly zero box with non-empty text
    if ((rect.width <= 2 || rect.height <= 2) && text.length > 0) reasons.push(`nearly zero box (${Math.round(rect.width)}x${Math.round(rect.height)})`);

    // Hidden by ancestors
    const anc = hasHiddenAncestor(el);
    if (anc) reasons.push(anc);

    // Occlusion check (only if seemingly on-screen)
    if (!offscreen && rect.width > 3 && rect.height > 3) {
      const occ = isOccluded(el);
      if (occ) reasons.push(occ);
    }

    return reasons;
  }

  function markElement(el) {
    if (!el || el.nodeType !== 1) return;
    el.setAttribute(ATTR_MARK, "1");
    el.classList.add(HIGHLIGHT_CLASS);
  }

  function markTargetElement(el) {
    if (!el || el.nodeType !== 1) return;
    el.setAttribute(ATTR_MARK, "1");
    el.classList.add(TARGET_HIGHLIGHT_CLASS);
  }

  function clearHighlightsAndPanel() {
    document.querySelectorAll(`.${HIGHLIGHT_CLASS}`).forEach(el => el.classList.remove(HIGHLIGHT_CLASS));
    document.querySelectorAll(`.${TARGET_HIGHLIGHT_CLASS}`).forEach(el => el.classList.remove(TARGET_HIGHLIGHT_CLASS));
    document.querySelectorAll(`[${ATTR_MARK}]`).forEach(el => el.removeAttribute(ATTR_MARK));
    document.getElementById(PANEL_ID)?.remove();
  }

  function resolveTargetElement(el) {
    if (!el || el.nodeType !== 1) return el;

    let cur = el;
    let fallback = el;
    let depth = 0;

    while (cur && cur.nodeType === 1 && depth < 12) {
      const cs = getComputedStyle(cur);
      const rect = cur.getBoundingClientRect();
      const visibleLike = cs.display !== "none" && cs.visibility !== "hidden" && rect.width >= 2 && rect.height >= 2;

      if (visibleLike) {
        fallback = cur;
        const looksContainer =
          /block|flex|grid|table|list-item/.test(cs.display) ||
          rect.width >= 120 ||
          rect.height >= 18;
        if (looksContainer) return cur;
      }

      cur = cur.parentElement;
      depth++;
    }

    return fallback;
  }

  function jumpToElement(el, targetEl) {
    const source = el;
    const target = resolveTargetElement(targetEl || el);
    if (!target) return;
    const alignTarget = target;

    // First attempt: native anchor-like behavior.
    alignTarget.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });

    // Fallback to absolute scroll if still out of viewport.
    setTimeout(() => {
      const rect = alignTarget.getBoundingClientRect();
      if (rect.top < 40 || rect.bottom > innerHeight - 40) {
        const offset = Math.max(120, Math.round(innerHeight * 0.18));
        const top = Math.max(0, window.scrollY + rect.top - offset);
        window.scrollTo({ top, behavior: "smooth" });
      }
    }, 120);

    if (source) source.classList.add(HIGHLIGHT_CLASS);
    const pulseTarget = source && source !== target ? target : source || target;

    if (source && source !== target) {
      target.classList.add(TARGET_HIGHLIGHT_CLASS);
    }

    if (pulseTarget) {
      pulseTarget.classList.add("htd-jump-pulse");
      pulseTarget.animate([{ transform: "scale(1)" }, { transform: "scale(1.02)" }, { transform: "scale(1)" }], { duration: 450 });
      setTimeout(() => pulseTarget.classList.remove("htd-jump-pulse"), 1500);
    }
  }

  function createPanel(items, notes) {
    document.getElementById(PANEL_ID)?.remove();

    const panel = document.createElement("div");
    panel.id = PANEL_ID;

    const header = document.createElement("div");
    header.className = "htd-header";

    const title = document.createElement("div");
    title.className = "htd-title";
    title.textContent = `${items.length} found`;

    const actions = document.createElement("div");
    actions.className = "htd-actions";
    const list = document.createElement("div");
    list.className = "htd-list";

    const copyBtn = document.createElement("button");
    copyBtn.textContent = "Copy JSON";
    copyBtn.addEventListener("click", async () => {
      const safe = items.map(i => ({
        selector: i.selector,
        snippet: i.snippet,
        source: i.source,
        reasons: i.reasons
      }));
      try {
        await navigator.clipboard.writeText(JSON.stringify({ notes, results: safe }, null, 2));
        copyBtn.textContent = "Copied!";
      } catch (_) {
        copyBtn.textContent = "Clipboard blocked";
      }
      setTimeout(() => (copyBtn.textContent = "Copy JSON"), 900);
    });

    const closeBtn = document.createElement("button");
    closeBtn.textContent = "Close";
    closeBtn.addEventListener("click", () => panel.remove());

    actions.append(copyBtn, closeBtn);
    header.append(title, actions);
    panel.append(header, list);

    if (notes.length) {
      const note = document.createElement("div");
      note.className = "htd-note";
      note.innerHTML = `<strong>Notes:</strong><br>${notes.map(n => `• ${escapeHtml(n)}`).join("<br>")}`;
      list.append(note);
    }

    for (const item of items) {
      const row = document.createElement("div");
      row.className = "htd-item";
      row.style.cursor = "pointer";
      row.style.userSelect = "none";
      row.tabIndex = 0;
      row.setAttribute("role", "button");

      let lastActivateTs = 0;
      const activateJump = (e) => {
        const now = performance.now();
        if (now - lastActivateTs < 220) return;
        lastActivateTs = now;

        if (e) {
          e.preventDefault();
          e.stopPropagation();
        }
        jumpToElement(item.el, item.targetEl || item.el);
      };

      row.addEventListener("pointerdown", activateJump);
      row.addEventListener("click", activateJump);
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") activateJump(e);
      });

      const reasons = document.createElement("div");
      reasons.className = "htd-reasons";
      reasons.innerHTML =
        `<strong>Reasons:</strong>` +
        `<ol class="htd-reason-list">` +
        item.reasons
          .map(r => `<li class="htd-reason-item"><span class="htd-reason-chip">${escapeHtml(r)}</span></li>`)
          .join("") +
        `</ol>`;

      const snippet = document.createElement("div");
      snippet.className = "htd-snippet";
      snippet.innerHTML = `<strong>Text:</strong> ${escapeHtml(item.snippet)}`;

      const meta = document.createElement("div");
      meta.className = "htd-meta";
      meta.innerHTML = `<strong>Score:</strong> <span class="htd-score-chip">${item.score}</span>`;

      row.append(reasons, snippet, meta);
      list.append(row);
    }

    document.documentElement.appendChild(panel);
  }

  function* walkAllRoots(rootDoc) {
    // main doc + shadow roots + same-origin iframes
    const stack = [{ doc: rootDoc, label: "document" }];
    while (stack.length) {
      const { doc, label } = stack.pop();
      yield { doc, label };

      const walker = createWalker(doc, NodeFilter.SHOW_ELEMENT);
      let visited = 0;
      let node = walker.nextNode();
      while (node) {
        visited++;
        if (visited > MAX_ROOT_DISCOVERY_ELEMENTS) break;

        if (node.shadowRoot) {
          stack.push({ doc: node.shadowRoot, label: "shadowRoot" });
        }

        if (node.tagName === "IFRAME") {
          try {
            const fd = node.contentDocument;
            if (fd) stack.push({ doc: fd, label: "iframe(same-origin)" });
          } catch (_) {
            // cross-origin; caller will record note
          }
        }

        node = walker.nextNode();
      }
    }
  }

  function scanInDoc(doc, sourceLabel, notes) {
    const results = [];
    let visitedTextNodes = 0;

    // Track cross-origin frames
    const frames = doc.querySelectorAll?.("iframe") || [];
    for (const f of frames) {
      try { void f.contentDocument; }
      catch (_) { notes.push("Skipped cross-origin iframe (browser blocks access)."); break; }
    }

    // 1) Text nodes
    const walker = createWalker(doc, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const t = normalizeText(node.nodeValue || "");
        if (!t) return NodeFilter.FILTER_REJECT;
        const p = node.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;

        const tag = p.tagName?.toLowerCase();
        if (["script", "style", "noscript"].includes(tag)) return NodeFilter.FILTER_REJECT;
        if (p.closest && p.closest(`#${PANEL_ID}`)) return NodeFilter.FILTER_REJECT;

        return NodeFilter.FILTER_ACCEPT;
      }
    });

    let node;
    while ((node = walker.nextNode())) {
      visitedTextNodes++;
      if (visitedTextNodes > MAX_TEXT_NODES) {
        notes.push(`Hit scan limit (${MAX_TEXT_NODES} text nodes). Results may be incomplete.`);
        break;
      }
      if (results.length >= MAX_RESULTS) {
        notes.push(`Hit result limit (${MAX_RESULTS}). Results may be incomplete.`);
        break;
      }

      const text = normalizeText(node.nodeValue || "");
      const el = node.parentElement;
      if (!el) continue;

      const cs = getComputedStyle(el);
      const reasons = analyzeTextLike(el, cs, text);
      if (!reasons.length) continue;

      results.push({
        el,
        selector: cssPath(el) || el.tagName.toLowerCase(),
        snippet: text.length > 160 ? text.slice(0, 160) + "…" : text,
        reasons,
        source: sourceLabel
      });
    }

    // 2) Pseudo-elements content (::before/::after)
    const pseudoWalker = createWalker(doc, NodeFilter.SHOW_ELEMENT);
    let visitedPseudoElements = 0;
    let pseudoNode = pseudoWalker.nextNode();
    while (pseudoNode) {
      const el = pseudoNode;
      visitedPseudoElements++;
      if (visitedPseudoElements > MAX_PSEUDO_ELEMENTS) {
        notes.push(`Hit pseudo-element limit (${MAX_PSEUDO_ELEMENTS}). Results may be incomplete.`);
        break;
      }
      if (results.length >= MAX_RESULTS) break;
      if (!(el.closest && el.closest(`#${PANEL_ID}`))) {
        for (const pseudo of ["::before", "::after"]) {
          const info = contentFromPseudo(el, pseudo);
          if (!info) continue;

          const pseudoText = info.text;
          // Use pseudo computed style for analysis where possible; still rely on parent for geometry
          const reasons = analyzeTextLike(el, info.cs, pseudoText);
          if (!reasons.length) continue;

          reasons.unshift(`${pseudo} content`);
          results.push({
            el,
            selector: cssPath(el) || el.tagName.toLowerCase(),
            snippet: pseudoText.length > 160 ? pseudoText.slice(0, 160) + "…" : pseudoText,
            reasons,
            source: `${sourceLabel} ${pseudo}`
          });

          if (results.length >= MAX_RESULTS) break;
        }
      }
      pseudoNode = pseudoWalker.nextNode();
    }

    return results;
  }

  function dedupeResults(items, mode = "merged") {
    if (mode === "expanded") {
      const seen = new Set();
      const out = [];
      for (const it of items) {
        const key = `${it.source}||${it.selector}||${it.snippet}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ ...it });
      }
      return out;
    }

    const merged = new Map();
    for (const it of items) {
      const key = `${it.source}||${it.selector}`;
      const prev = merged.get(key);
      if (!prev) {
        merged.set(key, { ...it });
        continue;
      }

      if (it.snippet.length > prev.snippet.length) {
        prev.snippet = it.snippet;
      }
      prev.reasons = [...new Set([...prev.reasons, ...it.reasons])];
    }
    return [...merged.values()];
  }

  function scanPage(tolerance = "default") {
    injectStylesOnce();
    clearHighlightsAndPanel();

    const notes = [];
    const allResults = [];
    const normalizedTolerance = normalizeTolerance(tolerance);
    notes.push(`Tolerance: ${normalizedTolerance}`);

    // Walk main doc + shadow roots + same-origin iframes
    for (const { doc, label } of walkAllRoots(document)) {
      const results = scanInDoc(doc, label, notes);
      allResults.push(...results);
      if (allResults.length >= MAX_RESULTS) break;
    }

    const dedupeMode = normalizedTolerance === "everything" ? "expanded" : "merged";
    const unique = dedupeResults(allResults, dedupeMode);
    const filtered = filterAndRankResults(unique, normalizedTolerance, notes).slice(0, MAX_RESULTS);
    for (const item of filtered) {
      item.targetEl = resolveTargetElement(item.el);
      markElement(item.el);
      if (item.targetEl && item.targetEl !== item.el) {
        markTargetElement(item.targetEl);
      }
    }

    if (filtered.length || notes.length) createPanel(filtered, notes);
    return filtered;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    try {
      if (msg?.type === "SCAN") {
        const found = scanPage(msg?.tolerance);
        sendResponse({ ok: true, count: found.length });
        return true;
      }
      if (msg?.type === "CLEAR") {
        clearHighlightsAndPanel();
        sendResponse({ ok: true });
        return true;
      }
    } catch (e) {
      sendResponse({ ok: false, error: e?.message || String(e) });
      return true;
    }
  });
})();
