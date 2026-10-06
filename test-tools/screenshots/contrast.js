// Run in the page (the harness passes it as a step): every visible text run in the chrome, its
// colour against the first opaque background behind it, and the ones under WCAG AA (4.5:1, or 3:1
// for large text). Content is skipped: the stage, the Look cards' previews, the overlays, the
// terminal. Disabled controls are skipped too (WCAG exempts them).
(() => {
  const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 }; };
  const lum = ({ r, g, b }) => [r, g, b].map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const skip = ".videoframe, .look-card-stage, .ov-layer, .assistant-term, .draft-player, [hidden], :disabled, .is-tiny";
  const background = (el) => {
    for (let node = el; node; node = node.parentElement) {
      const c = parse(getComputedStyle(node).backgroundColor);
      if (c && c.a > 0.9) return c;
    }
    return parse(getComputedStyle(document.body).backgroundColor);
  };
  const failures = [];
  let checked = 0;
  const modal = document.querySelector("dialog[open]");
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    if (!text.textContent.trim()) continue;
    const el = text.parentElement;
    if (!el || el.closest(skip) || el.closest("dialog:not([open])") || (modal && !modal.contains(el))) continue;
    const box = el.getBoundingClientRect();
    if (!box.width || !box.height || box.bottom < 0 || box.top > innerHeight) continue;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || Number(style.opacity) < 0.6) continue;
    const fg = parse(style.color);
    if (!fg) continue;
    checked += 1;
    const size = parseFloat(style.fontSize);
    const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
    const r = ratio(fg, background(el));
    if (r < (large ? 3 : 4.5)) failures.push({ text: text.textContent.trim().slice(0, 40), ratio: Math.round(r * 100) / 100, cls: el.className?.baseVal ?? el.className });
  }
  return { checked, failures: failures.slice(0, 12), failing: failures.length };
})()
