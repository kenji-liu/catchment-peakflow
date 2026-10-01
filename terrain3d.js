// 3D 地形：以 20 m DTM 建立網格 (mesh)，疊加國土測繪中心正射影像 / 電子地圖。
// 集水區、主流線、河系與雨量站直接畫在貼圖上，因此完全貼合地表。
/* global THREE, DEM */
const Terrain3D = (() => {
  const TILE = 256, MAX_SIDE = 400;
  const COLORS = { basin: '#ffd54a', main: '#ff7a1a', stream: '#7fd8ff', station: '#c9a6ff', pin: '#2aa7e0' };
  let renderer = null, scene, camera, controls, host, ro, group = null, pin = null, info = null, onAz = null, token = 0;

  const merc = (lat, lng, z) => {
    const s = TILE * 2 ** z, r = lat * Math.PI / 180;
    return [(lng + 180) / 360 * s, (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * s];
  };

  function setup(el) {
    host = el;
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputEncoding = THREE.sRGBEncoding;
    el.appendChild(renderer.domElement);
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(42, 1, 5, 5e5);
    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.maxPolarAngle = Math.PI * 0.48;
    controls.screenSpacePanning = false;
    controls.addEventListener('change', render);
    scene.add(new THREE.AmbientLight(0xffffff, 0.92));
    const sun = new THREE.DirectionalLight(0xffffff, 0.5);
    sun.position.set(-1, 1.3, -0.7); // 西北方光源，地形明暗與一般暈渲圖一致
    scene.add(sun);
    ro = new ResizeObserver(resize); ro.observe(el);
  }
  function resize() {
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix(); render();
  }
  function render() {
    if (!renderer) return;
    renderer.render(scene, camera);
    if (onAz) onAz(controls.getAzimuthalAngle());
  }

  async function texture(bb, layer, maxPx, progress) {
    let z = 18;
    for (; z > 8; z--) {
      const [x0, y0] = merc(bb.n, bb.w, z), [x1, y1] = merc(bb.s, bb.e, z);
      if (Math.max(x1 - x0, y1 - y0) <= maxPx) break;
    }
    const [px0, py0] = merc(bb.n, bb.w, z), [px1, py1] = merc(bb.s, bb.e, z);
    const tx0 = Math.floor(px0 / TILE), ty0 = Math.floor(py0 / TILE), tx1 = Math.floor(px1 / TILE), ty1 = Math.floor(py1 / TILE);
    const cv = document.createElement('canvas');
    cv.width = (tx1 - tx0 + 1) * TILE; cv.height = (ty1 - ty0 + 1) * TILE;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#6f7d74'; ctx.fillRect(0, 0, cv.width, cv.height);
    const jobs = [], total = (tx1 - tx0 + 1) * (ty1 - ty0 + 1);
    let done = 0;
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
      jobs.push(new Promise(res => {
        const img = new Image(); img.crossOrigin = 'anonymous';
        img.onload = () => { ctx.drawImage(img, (tx - tx0) * TILE, (ty - ty0) * TILE); done++; progress(`下載影像圖磚 ${done} / ${total}`); res(); };
        img.onerror = () => { done++; res(); };
        img.src = `https://wmts.nlsc.gov.tw/wmts/${layer}/default/GoogleMapsCompatible/${z}/${ty}/${tx}`;
      }));
    }
    await Promise.all(jobs);
    return { cv, ctx, z, ox: tx0 * TILE, oy: ty0 * TILE };
  }

  function paint(t, p) {
    const { ctx, cv } = t, lw = Math.max(2, cv.width / 650);
    const xy = q => { const [x, y] = merc(q[0], q[1], t.z); return [x - t.ox, y - t.oy]; };
    const path = pts => { ctx.beginPath(); pts.forEach((q, i) => { const [x, y] = xy(q); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); };
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    if (p.poly && p.poly.length > 2) { // 集水區外略為壓暗，區內保持原色
      ctx.save(); ctx.beginPath(); ctx.rect(0, 0, cv.width, cv.height);
      p.poly.forEach((q, i) => { const [x, y] = xy(q); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.closePath(); ctx.fillStyle = 'rgba(10,20,25,0.22)'; ctx.fill('evenodd'); ctx.restore();
    }
    for (const s of p.streams || []) { path(s); ctx.strokeStyle = COLORS.stream; ctx.lineWidth = lw * 0.55; ctx.stroke(); }
    ctx.save(); ctx.setLineDash([lw * 4, lw * 3]);
    for (const c of p.cells || []) { path(c); ctx.closePath(); ctx.strokeStyle = COLORS.station; ctx.lineWidth = lw * 0.9; ctx.stroke(); }
    ctx.restore();
    if (p.poly && p.poly.length > 2) {
      path(p.poly); ctx.closePath();
      ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.lineWidth = lw * 2.2; ctx.stroke();
      ctx.strokeStyle = COLORS.basin; ctx.lineWidth = lw * 1.2; ctx.stroke();
    }
    if (p.line && p.line.length > 1) {
      path(p.line); ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.lineWidth = lw * 2.4; ctx.stroke();
      ctx.strokeStyle = COLORS.main; ctx.lineWidth = lw * 1.4; ctx.stroke();
    }
    ctx.font = `700 ${Math.round(lw * 7)}px "Noto Sans TC", sans-serif`;
    for (const s of p.stations || []) {
      const [x, y] = xy([s.lat, s.lng]);
      if (x < 0 || y < 0 || x > cv.width || y > cv.height) continue;
      ctx.beginPath(); ctx.arc(x, y, lw * 2.4, 0, 7); ctx.fillStyle = COLORS.station; ctx.fill();
      ctx.lineWidth = lw * 0.8; ctx.strokeStyle = '#fff'; ctx.stroke();
      ctx.lineWidth = lw * 1.6; ctx.strokeStyle = 'rgba(0,0,0,0.7)'; ctx.strokeText(s.name, x + lw * 3.5, y - lw * 2);
      ctx.fillStyle = '#fff'; ctx.fillText(s.name, x + lw * 3.5, y - lw * 2);
    }
  }

  function clearScene() {
    for (const o of [group, pin]) if (o) {
      scene.remove(o);
      o.traverse(m => { if (m.geometry) m.geometry.dispose(); if (m.material) { if (m.material.map) m.material.map.dispose(); m.material.dispose(); } });
    }
    group = pin = null;
  }

  // p: { lat, lng, poly, line, streams, stations, layer, hiRes, exag }
  async function open(el, p, progress = () => {}) {
    const my = ++token;
    if (!renderer) setup(el);
    if (!renderer.getContext()) throw new Error('瀏覽器不支援 WebGL，無法顯示 3D 地形。');
    // 1. 範圍：集水區外框外擴 25%；沒有集水區則取控制點周圍 5 km
    const pts = (p.poly && p.poly.length > 2 ? p.poly : [[p.lat, p.lng]]).map(q => DEM.toTM(q[0], q[1]));
    let E0 = Math.min(...pts.map(q => q[0])), E1 = Math.max(...pts.map(q => q[0]));
    let N0 = Math.min(...pts.map(q => q[1])), N1 = Math.max(...pts.map(q => q[1]));
    const cx = (E0 + E1) / 2, cy = (N0 + N1) / 2;
    const half = Math.min(20000, Math.max(1500, Math.max(E1 - E0, N1 - N0) * 0.625, pts.length === 1 ? 2500 : 0));
    E0 = cx - half; E1 = cx + half; N0 = cy - half; N1 = cy + half;
    const step = Math.max(1, Math.ceil(half * 2 / DEM.meta.cell / MAX_SIDE));
    progress('讀取 20 m 地形網格…');
    const g = await DEM.grid(E0, N0, E1, N1, step);
    if (my !== token) return null;
    if (!isFinite(g.zmin)) throw new Error('此範圍沒有地形資料。');
    // 2. 貼圖範圍 (經緯度)
    const Eg1 = g.E0 + (g.nx - 1) * g.d, Ng1 = g.N0 - (g.ny - 1) * g.d;
    const corners = [[g.E0, g.N0], [Eg1, g.N0], [g.E0, Ng1], [Eg1, Ng1]].map(q => DEM.toLL(q[0], q[1]));
    const bb = { n: Math.max(...corners.map(c => c[0])), s: Math.min(...corners.map(c => c[0])), w: Math.min(...corners.map(c => c[1])), e: Math.max(...corners.map(c => c[1])) };
    const t = await texture(bb, p.layer || 'PHOTO2', p.hiRes ? 4096 : 2048, progress);
    if (my !== token) return null;
    paint(t, p);
    progress('建立地形網格…');

    // 3. 網格：x 向東、z 向南、y 為高程 (相對最低點)
    const { nx, ny, d } = g, n = nx * ny, hmin = g.zmin;
    const Ec = g.E0 + (nx - 1) * d / 2, Nc = g.N0 - (ny - 1) * d / 2;
    const pos = new Float32Array(n * 3), uv = new Float32Array(n * 2);
    const W = t.cv.width, H = t.cv.height;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const k = j * nx + i, E = g.E0 + i * d, N = g.N0 - j * d, h = g.z[k];
      pos[k * 3] = E - Ec; pos[k * 3 + 1] = (isNaN(h) ? hmin : h) - hmin; pos[k * 3 + 2] = Nc - N;
      const ll = DEM.toLL(E, N), [px, py] = merc(ll[0], ll[1], t.z);
      uv[k * 2] = (px - t.ox) / W; uv[k * 2 + 1] = 1 - (py - t.oy) / H;
    }
    const idx = new (n > 65535 ? Uint32Array : Uint16Array)((nx - 1) * (ny - 1) * 6);
    let q = 0;
    for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, e = c + 1;
      idx[q++] = a; idx[q++] = c; idx[q++] = b; idx[q++] = b; idx[q++] = c; idx[q++] = e;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeVertexNormals();
    const tex = new THREE.CanvasTexture(t.cv);
    tex.encoding = THREE.sRGBEncoding; tex.anisotropy = renderer.capabilities.getMaxAnisotropy();

    // 4. 四周裙邊，讓地形呈現塊體剖面
    const base = -Math.max(30, (g.zmax - hmin) * 0.08);
    const wall = [];
    const edge = list => {
      for (let s = 0; s < list.length - 1; s++) {
        const A = list[s], B = list[s + 1];
        const ax = pos[A * 3], ay = pos[A * 3 + 1], az = pos[A * 3 + 2], bx = pos[B * 3], by = pos[B * 3 + 1], bz = pos[B * 3 + 2];
        wall.push(ax, ay, az, ax, base, az, bx, by, bz, bx, by, bz, ax, base, az, bx, base, bz);
      }
    };
    edge([...Array(nx).keys()]);
    edge([...Array(nx).keys()].map(i => (ny - 1) * nx + i));
    edge([...Array(ny).keys()].map(j => j * nx));
    edge([...Array(ny).keys()].map(j => j * nx + nx - 1));
    const wgeo = new THREE.BufferGeometry();
    wgeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(wall), 3));
    wgeo.computeVertexNormals();

    clearScene();
    group = new THREE.Group();
    group.add(new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map: tex })));
    group.add(new THREE.Mesh(wgeo, new THREE.MeshLambertMaterial({ color: 0x8a7b66, side: THREE.DoubleSide })));
    scene.add(group);

    // 5. 控制點標記
    const [pE, pN] = DEM.toTM(p.lat, p.lng);
    const pi = Math.round((pE - g.E0) / d), pj = Math.round((g.N0 - pN) / d);
    const ph = g.z[Math.min(ny - 1, Math.max(0, pj)) * nx + Math.min(nx - 1, Math.max(0, pi))];
    const span = half * 2, ht = span * 0.07;
    pin = new THREE.Group();
    const stick = new THREE.Mesh(new THREE.CylinderGeometry(span * 0.0025, span * 0.0025, ht, 12), new THREE.MeshLambertMaterial({ color: 0xffffff }));
    stick.position.y = ht / 2;
    const head = new THREE.Mesh(new THREE.SphereGeometry(span * 0.011, 24, 16), new THREE.MeshLambertMaterial({ color: COLORS.pin, emissive: 0x0a3a50 }));
    head.position.y = ht;
    pin.add(stick, head);
    pin.userData = { x: pE - Ec, h: (isNaN(ph) ? hmin : ph) - hmin, z: Nc - pN };
    scene.add(pin);

    info = { span, relief: g.zmax - hmin, mid: (g.zmax - hmin) / 2, zmin: hmin, zmax: g.zmax, step: d, nx, ny, zoom: t.z, texW: W, texH: H };
    setExag(p.exag || 1.5, false);
    resize();
    resetView();
    progress('');
    return info;
  }

  function setExag(v, redraw = true) {
    if (!group) return;
    group.scale.y = v;
    if (pin) pin.position.set(pin.userData.x, pin.userData.h * v, pin.userData.z);
    info.exag = v;
    if (redraw) render();
  }
  function resetView() {
    if (!info) return;
    const s = info.span, y = info.mid * (info.exag || 1);
    controls.target.set(0, y, 0);
    const k = Math.max(1, 1.25 / Math.min(1, camera.aspect)); // 窄畫面時拉遠
    camera.position.set(-s * 0.62 * k, y + s * 0.72 * k, s * 0.88 * k); // 由西南方俯視
    camera.near = s / 2000; camera.far = s * 20; camera.updateProjectionMatrix();
    controls.update(); render();
  }
  function onAzimuth(fn) { onAz = fn; }
  function cancel() { token++; }
  return { open, setExag, resetView, onAzimuth, cancel, resize: () => renderer && resize() };
})();
