"""將內政部 20 m DTM (GeoTIFF) 前處理為網頁用的水文圖磚。

流程：Priority-Flood+ε 填窪 (Barnes et al., 2014) → D8 流向 → 流量累積 → 500×500 網格圖磚。
每塊圖磚 = zlib( 高程碼 uint16[N] | 累積碼 uint16[N] | 流向 uint8[N] )，N = 500×500。
  高程碼 = round((h + 100) × 10)，0 表示無資料
  累積碼 = round(log10(累積格數) × 9000)，上限 65535
  流向   = 0 東、1 東南、2 南、3 西南、4 西、5 西北、6 北、7 東北、8 出海口/邊界出口、255 無資料

用法：python build_dem_tiles.py <DEM_tawiwan_V2025.tif> <輸出資料夾>
"""
import json
import os
import sys
import time
import zlib

import numba as nb
import numpy as np
import rasterio

T = 500  # 圖磚邊長 (格)
DX = np.array([1, 1, 0, -1, -1, -1, 0, 1], np.int64)
DY = np.array([0, 1, 1, 1, 0, -1, -1, -1], np.int64)
OFFSET = np.float32(200.0)  # 讓所有高程為正值，便於 nextafter 遞增


@nb.njit(cache=True)
def _push(hk, hi, size, k, i):
    j = size
    hk[j] = k
    hi[j] = i
    while j > 0:
        p = (j - 1) >> 1
        if hk[p] <= hk[j]:
            break
        hk[p], hk[j] = hk[j], hk[p]
        hi[p], hi[j] = hi[j], hi[p]
        j = p
    return size + 1


@nb.njit(cache=True)
def _pop(hk, hi, size):
    top = hi[0]
    size -= 1
    hk[0] = hk[size]
    hi[0] = hi[size]
    j = 0
    while True:
        l = 2 * j + 1
        if l >= size:
            break
        r = l + 1
        m = l if (r >= size or hk[l] <= hk[r]) else r
        if hk[j] <= hk[m]:
            break
        hk[m], hk[j] = hk[j], hk[m]
        hi[m], hi[j] = hi[j], hi[m]
        j = m
    return top, size


@nb.njit(cache=True)
def priority_flood_eps(z, valid, ny, nx):
    n = ny * nx
    closed = np.zeros(n, np.uint8)
    hk = np.empty(n, np.float32)
    hi = np.empty(n, np.int32)
    pit = np.empty(n, np.int32)
    hs = 0
    ph = 0
    pt = 0
    inf = np.float32(np.inf)
    for c in range(n):
        if not valid[c]:
            closed[c] = 1
            continue
        r = c // nx
        col = c - r * nx
        seed = r == 0 or r == ny - 1 or col == 0 or col == nx - 1
        if not seed:
            for k in range(8):
                if not valid[(r + DY[k]) * nx + col + DX[k]]:
                    seed = True
                    break
        if seed:
            closed[c] = 1
            hs = _push(hk, hi, hs, z[c], c)
    while hs > 0 or ph < pt:
        if ph < pt:
            c = pit[ph]
            ph += 1
        else:
            c, hs = _pop(hk, hi, hs)
        zc = z[c]
        zn = np.nextafter(zc, inf)
        r = c // nx
        col = c - r * nx
        for k in range(8):
            rr = r + DY[k]
            cc = col + DX[k]
            if rr < 0 or rr >= ny or cc < 0 or cc >= nx:
                continue
            m = rr * nx + cc
            if closed[m]:
                continue
            closed[m] = 1
            if z[m] <= zn:
                z[m] = zn
                pit[pt] = m
                pt += 1
            else:
                hs = _push(hk, hi, hs, z[m], m)


@nb.njit(parallel=True, cache=True)
def d8(z, valid, ny, nx):
    dirs = np.full(ny * nx, 255, np.uint8)
    for r in nb.prange(ny):
        for col in range(nx):
            c = r * nx + col
            if not valid[c]:
                continue
            best = np.float32(0.0)
            bk = 8
            for k in range(8):
                rr = r + DY[k]
                cc = col + DX[k]
                if rr < 0 or rr >= ny or cc < 0 or cc >= nx:
                    continue
                m = rr * nx + cc
                if not valid[m]:
                    continue
                d = z[c] - z[m]
                if k % 2 == 1:
                    d = d / np.float32(1.41421356)
                if d > best:
                    best = d
                    bk = k
            dirs[c] = bk
    return dirs


@nb.njit(cache=True)
def accumulate(dirs, ny, nx):
    n = ny * nx
    indeg = np.zeros(n, np.uint8)
    acc = np.zeros(n, np.uint32)
    for c in range(n):
        d = dirs[c]
        if d == 255:
            continue
        acc[c] = 1
        if d < 8:
            r = c // nx
            indeg[(r + DY[d]) * nx + c - r * nx + DX[d]] += 1
    stack = np.empty(n, np.int32)
    sp = 0
    for c in range(n):
        if dirs[c] != 255 and indeg[c] == 0:
            stack[sp] = c
            sp += 1
    while sp > 0:
        sp -= 1
        c = stack[sp]
        d = dirs[c]
        if d < 8:
            r = c // nx
            m = (r + DY[d]) * nx + c - r * nx + DX[d]
            acc[m] += acc[c]
            indeg[m] -= 1
            if indeg[m] == 0:
                stack[sp] = m
                sp += 1
    return acc


def main(src, out):
    t0 = time.time()
    with rasterio.open(src) as ds:
        dem = ds.read(1)
        nodata = ds.nodata
        tr = ds.transform
    ny, nx = dem.shape
    valid2d = np.isfinite(dem) & (dem != nodata) & (dem > -1000)
    print(f"讀取 {nx}×{ny}，有效格 {valid2d.sum():,}，{time.time() - t0:.0f}s", flush=True)

    elev = dem.copy()
    z = np.where(valid2d, dem + OFFSET, 0).astype(np.float32).ravel()
    valid = valid2d.ravel()
    del dem
    priority_flood_eps(z, valid, ny, nx)
    print(f"填窪完成 {time.time() - t0:.0f}s", flush=True)
    dirs = d8(z, valid, ny, nx)
    del z
    print(f"D8 完成 {time.time() - t0:.0f}s", flush=True)
    acc = accumulate(dirs, ny, nx)
    print(f"累積完成 {time.time() - t0:.0f}s，最大累積 {acc.max():,} 格 = {acc.max() * 400 / 1e6:,.1f} km²", flush=True)

    ecode = np.where(valid2d, np.clip(np.round((elev + 100) * 10), 1, 65535), 0).astype(np.uint16)
    acode = np.where(acc.reshape(ny, nx) > 0,
                     np.clip(np.round(np.log10(np.maximum(acc, 1)).reshape(ny, nx) * 9000), 0, 65535), 0).astype(np.uint16)
    dirs2 = dirs.reshape(ny, nx)
    del acc, elev

    os.makedirs(os.path.join(out, "t"), exist_ok=True)
    tiles, total = [], 0
    for ty in range((ny + T - 1) // T):
        for tx in range((nx + T - 1) // T):
            r0, c0 = ty * T, tx * T
            r1, c1 = min(r0 + T, ny), min(c0 + T, nx)
            if not valid2d[r0:r1, c0:c1].any():
                continue
            e = np.zeros((T, T), np.uint16); a = np.zeros((T, T), np.uint16); d = np.full((T, T), 255, np.uint8)
            e[: r1 - r0, : c1 - c0] = ecode[r0:r1, c0:c1]
            a[: r1 - r0, : c1 - c0] = acode[r0:r1, c0:c1]
            d[: r1 - r0, : c1 - c0] = dirs2[r0:r1, c0:c1]
            # 高程以列內差分編碼 (uint16 環繞)，壓縮率較佳
            ed = e.copy()
            ed[:, 1:] = (e[:, 1:].astype(np.int32) - e[:, :-1].astype(np.int32)).astype(np.uint16)
            blob = zlib.compress(ed.tobytes() + a.tobytes() + d.tobytes(), 9)
            with open(os.path.join(out, "t", f"{tx}_{ty}.bin"), "wb") as f:
                f.write(blob)
            tiles.append([tx, ty])
            total += len(blob)
    meta = {
        "source": "內政部地政司 2025年版全臺灣20公尺網格數值地形模型DTM資料 (政府資料開放授權條款-第1版)",
        "crs": "+proj=tmerc +lat_0=0 +lon_0=121 +k=0.9999 +x_0=250000 +y_0=0 +ellps=GRS80 +units=m +no_defs",
        "E0": tr.c + tr.a / 2, "N0": tr.f + tr.e / 2, "cell": tr.a, "NX": nx, "NY": ny, "T": T,
        "elevOffset": 100, "elevScale": 10, "accScale": 9000, "deltaRows": True,
        "dirs": "0E 1SE 2S 3SW 4W 5NW 6N 7NE 8outlet 255nodata", "tiles": tiles,
    }
    with open(os.path.join(out, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False)
    print(f"圖磚 {len(tiles)} 塊，共 {total / 1e6:.1f} MB，總耗時 {time.time() - t0:.0f}s", flush=True)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
