// orbit-kit: the one world this film draws in. A planet of radius 1 at the
// origin, gravity towards it, and a ball launched sideways from a point just
// above the ground. Every path is integrated once, here, so every frame reads
// the same numbers.
(() => {
  const R0 = 1.06;
  function path(v, { dt = 0.0008, keep = 4 } = {}) {
    let x = 0, y = -R0, vx = v, vy = 0;
    const acc = (px, py) => { const r = Math.hypot(px, py); return [-px / r ** 3, -py / r ** 3]; };
    let [ax, ay] = acc(x, y);
    const pts = [[x, y]];
    let turned = 0, prev = Math.atan2(y, x), landed = false;
    for (let i = 1; i < 200000; i += 1) {
      x += vx * dt + 0.5 * ax * dt * dt; y += vy * dt + 0.5 * ay * dt * dt;
      const [nx, ny] = acc(x, y);
      vx += 0.5 * (ax + nx) * dt; vy += 0.5 * (ay + ny) * dt; ax = nx; ay = ny;
      let d = Math.atan2(y, x) - prev; prev += d;
      if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI;
      turned += d;
      const r = Math.hypot(x, y);
      if (r < 1) { pts.push([x / r, y / r]); landed = true; break; }
      if (i % keep === 0) pts.push([x, y]);
      if (Math.abs(turned) >= 2 * Math.PI) { pts.push([0, -R0]); break; }
    }
    return { pts, landed, v };
  }
  // The point a fraction k (0→1) of the way along a path, in sim time.
  function at(p, k) {
    const f = Math.min(Math.max(k, 0), 1) * (p.pts.length - 1);
    const i = Math.floor(f), j = Math.min(i + 1, p.pts.length - 1), u = f - i;
    return [p.pts[i][0] + (p.pts[j][0] - p.pts[i][0]) * u, p.pts[i][1] + (p.pts[j][1] - p.pts[i][1]) * u];
  }
  // An SVG polyline's points for the first k of a path, in screen pixels.
  function trail(p, k, project) {
    const n = Math.max(1, Math.floor(Math.min(Math.max(k, 0), 1) * (p.pts.length - 1)));
    const out = [];
    for (let i = 0; i <= n; i += 1) { const [sx, sy] = project(p.pts[i]); out.push(`${sx.toFixed(1)},${sy.toFixed(1)}`); }
    const [ex, ey] = project(at(p, k)); out.push(`${ex.toFixed(1)},${ey.toFixed(1)}`);
    return out.join(" ");
  }
  window.orbitKit = { R0, path, at, trail, circular: 1 / Math.sqrt(R0) };
})();
