// 20 m DTM 水文圖磚：依控制點自動圈繪集水區、最長流路 (主流線) 與河系。
// 圖磚由 tools/build_dem_tiles.py 產生（Priority-Flood+ε 填窪、D8 流向、流量累積）。
/* global proj4, pako */
const DEM = (() => {
  const DX = [1, 1, 0, -1, -1, -1, 0, 1], DY = [0, 1, 1, 1, 0, -1, -1, -1];
  let meta = null, base = 'dem/', tileSet = null;
  const cache = new Map(); // key -> Promise<tile|null>
  const loaded = new Map(); // key -> tile

  async function init(path = 'dem/') {
    base = path;
    const r = await fetch(base + 'meta.json');
    if (!r.ok) throw new Error('找不到地形資料 (meta.json)');
    meta = await r.json();
    tileSet = new Set(meta.tiles.map(t => t[0] + '_' + t[1]));
    proj4.defs('TM2', meta.crs);
    return meta;
  }
  const toTM = (lat, lng) => proj4('EPSG:4326', 'TM2', [lng, lat]);
  const toLL = (E, N) => { const p = proj4('TM2', 'EPSG:4326', [E, N]); return [p[1], p[0]]; };
  const cellOf = (E, N) => [Math.round((E - meta.E0) / meta.cell), Math.round((meta.N0 - N) / meta.cell)];
  const cellXY = (c, r) => [meta.E0 + c * meta.cell, meta.N0 - r * meta.cell];

  function decode(buf) {
    const T = meta.T, n = T * T;
    const raw = pako.inflate(new Uint8Array(buf));
    const e = new Uint16Array(raw.buffer, raw.byteOffset, n).slice();
    const a = new Uint16Array(raw.buffer, raw.byteOffset + n * 2, n).slice();
    const d = raw.slice(n * 4, n * 5);
    if (meta.deltaRows) for (let r = 0; r < T; r++) { const o = r * T; for (let c = 1; c < T; c++) e[o + c] = e[o + c] + e[o + c - 1]; }
    return { e, a, d };
  }
  function tile(tx, ty) {
    const k = tx + '_' + ty;
    if (!cache.has(k)) {
      cache.set(k, !tileSet.has(k) ? Promise.resolve(null) :
        fetch(`${base}t/${k}.bin`).then(r => { if (!r.ok) throw new Error(`圖磚 ${k} 下載失敗`); return r.arrayBuffer(); })
          .then(b => { const t = decode(b); loaded.set(k, t); return t; }));
    }
    return cache.get(k);
  }
  const tkey = (c, r) => Math.floor(c / meta.T) + '_' + Math.floor(r / meta.T);
  const isLoaded = (c, r) => !tileSet.has(tkey(c, r)) || loaded.has(tkey(c, r));
  function at(c, r) { // 回傳 [高程(m), 累積格數, 流向]；無資料回傳 null
    if (c < 0 || r < 0 || c >= meta.NX || r >= meta.NY) return null;
    const t = loaded.get(tkey(c, r)); if (!t) return null;
    const i = (r % meta.T) * meta.T + (c % meta.T);
    if (t.d[i] === 255) return null;
    return [t.e[i] / meta.elevScale - meta.elevOffset, Math.pow(10, t.a[i] / meta.accScale), t.d[i]];
  }
  async function ensure(c0, r0, c1, r1) {
    const T = meta.T, jobs = [];
    for (let ty = Math.floor(r0 / T); ty <= Math.floor(r1 / T); ty++)
      for (let tx = Math.floor(c0 / T); tx <= Math.floor(c1 / T); tx++) jobs.push(tile(tx, ty));
    await Promise.all(jobs);
  }
  async function elevation(lat, lng) {
    const [E, N] = toTM(lat, lng), [c, r] = cellOf(E, N);
    await ensure(c, r, c, r); const v = at(c, r); return v ? v[0] : null;
  }

  function simplify(pts, tol) { // Douglas-Peucker（平面座標）
    if (pts.length < 3) return pts;
    const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
    const st = [[0, pts.length - 1]], t2 = tol * tol;
    while (st.length) {
      const [a, b] = st.pop(); const [ax, ay] = pts[a], [bx, by] = pts[b];
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1;
      let mi = -1, md = t2;
      for (let i = a + 1; i < b; i++) {
        const [px, py] = pts[i]; let u = ((px - ax) * dx + (py - ay) * dy) / L2; u = Math.max(0, Math.min(1, u));
        const qx = ax + u * dx - px, qy = ay + u * dy - py, d = qx * qx + qy * qy;
        if (d > md) { md = d; mi = i; }
      }
      if (mi > 0) { keep[mi] = 1; st.push([a, mi], [mi, b]); }
    }
    return pts.filter((_, i) => keep[i]);
  }

  async function delineate(lat, lng, opt = {}) {
    const snapM = opt.snap ?? 100, maxCells = opt.maxCells ?? 8e6, progress = opt.onProgress || (() => {});
    const { NX, NY, T, cell } = meta;
    const [E, N] = toTM(lat, lng), [pc, pr] = cellOf(E, N);
    const R = Math.max(1, Math.round(snapM / cell));
    await ensure(pc - R, pr - R, pc + R, pr + R);
    // 1. 控制點吸附：半徑內最近的河道格 (上游面積 ≥ snapCells)；附近沒有河道才取累積量最大者。
    //    取「最近」而非「最大」，避免在匯流口附近被吸到主流。
    const sc = opt.snapCells ?? 250;
    let oc = -1, or = -1, best = -1, nc = -1, nr = -1, nd = Infinity, na = 0;
    for (let r = pr - R; r <= pr + R; r++) for (let c = pc - R; c <= pc + R; c++) {
      const d2 = (c - pc) ** 2 + (r - pr) ** 2; if (d2 > R * R) continue;
      const v = at(c, r); if (!v) continue;
      if (v[1] > best) { best = v[1]; oc = c; or = r; }
      if (v[1] >= sc && (d2 < nd || (d2 === nd && v[1] > na))) { nd = d2; na = v[1]; nc = c; nr = r; }
    }
    if (nc >= 0) { oc = nc; or = nr; }
    if (oc < 0) throw new Error('控制點不在臺灣本島 20 m DTM 範圍內。');

    // 2. 由出口往上游追溯 (遇到未載入的圖磚就先下載)
    const mask = new Map(), dist = new Map();
    const mget = (c, r) => { const m = mask.get(tkey(c, r)); return m ? m[(r % T) * T + (c % T)] : 0; };
    const mset = (c, r, d) => {
      const k = tkey(c, r); let m = mask.get(k);
      if (!m) { m = new Uint8Array(T * T); mask.set(k, m); dist.set(k, new Float32Array(T * T)); }
      const i = (r % T) * T + (c % T); m[i] = 1; dist.get(k)[i] = d;
    };
    const dget = (c, r) => dist.get(tkey(c, r))[(r % T) * T + (c % T)];
    let queue = [oc, or], deferred = [], count = 1, far = 0, fc = oc, fr = or, zmax = -1e9;
    mset(oc, or, 0);
    while (queue.length) {
      for (let q = 0; q < queue.length; q += 2) {
        const c = queue[q], r = queue[q + 1];
        let ready = true;
        for (let k = 0; k < 8; k++) if (!isLoaded(c + DX[k], r + DY[k])) { ready = false; tile(Math.floor((c + DX[k]) / T), Math.floor((r + DY[k]) / T)); }
        if (!ready) { deferred.push(c, r); continue; }
        const d0 = dget(c, r), z0 = at(c, r)[0]; if (z0 > zmax) zmax = z0;
        for (let k = 0; k < 8; k++) {
          const nc = c + DX[k], nr = r + DY[k];
          if (mget(nc, nr)) continue;
          const v = at(nc, nr);
          if (!v || v[2] !== ((k + 4) & 7)) continue; // 鄰格流向必須指回本格
          const dn = d0 + (k & 1 ? cell * Math.SQRT2 : cell);
          mset(nc, nr, dn); queue.push(nc, nr); count++;
          if (dn > far) { far = dn; fc = nc; fr = nr; }
        }
        if (count > maxCells) throw new Error(`集水區超過 ${(maxCells * cell * cell / 1e6).toFixed(0)} km²，超出網頁自動圈繪上限。`);
      }
      queue = [];
      if (deferred.length) {
        progress(`已追溯 ${(count * cell * cell / 1e6).toFixed(2)} km²，載入上游地形圖磚…`);
        await Promise.all([...cache.values()]);
        queue = deferred; deferred = [];
      }
    }

    // 3. 最長流路 (由最遠源頭沿流向到出口)
    const path = [];
    let c = fc, r = fr, guard = 0;
    while (guard++ < 1e6) {
      path.push(cellXY(c, r));
      if (c === oc && r === or) break;
      const v = at(c, r); if (!v || v[2] > 7) break;
      c += DX[v[2]]; r += DY[v[2]];
    }
    const zHead = at(fc, fr)[0], zOut = at(oc, or)[0];

    // 4. 集水區外框：收集遮罩邊界邊，串成封閉環，取最長者
    const W = NX + 1, next = new Map();
    const addEdge = (x1, y1, x2, y2) => { const k = y1 * W + x1; const v = y2 * W + x2; const l = next.get(k); if (l) l.push(v); else next.set(k, [v]); };
    for (const [k, m] of mask) {
      const [tx, ty] = k.split('_').map(Number);
      for (let i = 0; i < T * T; i++) {
        if (!m[i]) continue;
        const cc = tx * T + (i % T), rr = ty * T + Math.floor(i / T);
        if (!mget(cc, rr - 1)) addEdge(cc, rr, cc + 1, rr);
        if (!mget(cc + 1, rr)) addEdge(cc + 1, rr, cc + 1, rr + 1);
        if (!mget(cc, rr + 1)) addEdge(cc + 1, rr + 1, cc, rr + 1);
        if (!mget(cc - 1, rr)) addEdge(cc, rr + 1, cc, rr);
      }
    }
    let ring = [];
    while (next.size) {
      const start = next.keys().next().value, loop = [];
      let cur = start;
      while (true) {
        loop.push(cur);
        const l = next.get(cur); if (!l) break;
        const nx = l.pop(); if (!l.length) next.delete(cur);
        cur = nx; if (cur === start) break;
      }
      if (loop.length > ring.length) ring = loop;
    }
    const half = cell / 2;
    let poly = ring.map(k => [meta.E0 - half + (k % W) * cell, meta.N0 + half - Math.floor(k / W) * cell]);
    poly = simplify(poly.concat([poly[0]]), cell * 0.75).slice(0, -1);

    // 5. 河系：集水區內累積面積超過門檻的格，由源頭往下游串成線
    const thr = Math.max(opt.streamCells ?? 250, count * 0.004);
    const isStream = (c, r) => { if (!mget(c, r)) return false; const v = at(c, r); return v && v[1] >= thr; };
    const up = new Map(), streamCells = [];
    for (const [k, m] of mask) {
      const [tx, ty] = k.split('_').map(Number);
      for (let i = 0; i < T * T; i++) {
        if (!m[i]) continue;
        const cc = tx * T + (i % T), rr = ty * T + Math.floor(i / T);
        if (!isStream(cc, rr)) continue;
        streamCells.push(cc, rr);
        const v = at(cc, rr);
        if (v[2] < 8) { const dk = (rr + DY[v[2]]) * NX + cc + DX[v[2]]; up.set(dk, (up.get(dk) || 0) + 1); }
      }
    }
    const seen = new Set(), streams = [];
    for (let s = 0; s < streamCells.length; s += 2) {
      let c2 = streamCells[s], r2 = streamCells[s + 1];
      if (up.get(r2 * NX + c2)) continue; // 只從源頭開始
      const line = [];
      while (true) {
        line.push(cellXY(c2, r2));
        const id = r2 * NX + c2; if (seen.has(id)) break; seen.add(id);
        const v = at(c2, r2); if (!v || v[2] > 7 || (c2 === oc && r2 === or)) break;
        c2 += DX[v[2]]; r2 += DY[v[2]]; if (!mget(c2, r2)) break;
      }
      if (line.length > 1) streams.push(simplify(line, cell * 0.6));
    }

    const ll = p => toLL(p[0], p[1]);
    const [oE, oN] = cellXY(oc, or);
    return {
      outlet: toLL(oE, oN), snapM: Math.hypot(oE - E, oN - N),
      cells: count, areaHa: count * cell * cell / 1e4,
      L_km: far / 1000, H_m: zHead - zOut, zHead, zOut, zMax: zmax,
      polygon: poly.map(ll), mainLine: simplify(path, cell * 0.6).map(ll), streams: streams.map(l => l.map(ll)),
      tiles: loaded.size,
    };
  }
  return { init, delineate, elevation, toTM, toLL, get meta() { return meta; } };
})();
