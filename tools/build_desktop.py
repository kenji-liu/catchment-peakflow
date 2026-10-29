"""準備桌面版 (desktop/) 的網頁檔：

1. 先執行 build_index.py 產生最新 index.html
2. 複製 index.html、dem.js、terrain3d.js、dem/ 到 desktop/site/
3. 下載 CDN 函式庫 (Leaflet、Chart.js、SheetJS、proj4、pako、three.js、d3-delaunay) 到 desktop/site/vendor/，
   並把 index.html 內的網址改為本機路徑，讓計算功能離線可用 (底圖與正射影像仍需連網)
4. 產生應用程式圖示 desktop/icon.png、desktop/icon.ico

之後在 desktop/ 執行 npm install、npm run dist 產生安裝檔。
"""
import os
import shutil
import subprocess
import sys
import urllib.request

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
DESK = os.path.join(REPO, "desktop")
SITE = os.path.join(DESK, "site")
VENDOR = os.path.join(SITE, "vendor")

LIBS = [
    "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css",
    "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js",
    "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js",
    "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js",
    "https://cdnjs.cloudflare.com/ajax/libs/proj4js/2.11.0/proj4.js",
    "https://cdnjs.cloudflare.com/ajax/libs/pako/2.1.0/pako.min.js",
    "https://cdn.jsdelivr.net/npm/three@0.147.0/build/three.min.js",
    "https://cdn.jsdelivr.net/npm/three@0.147.0/examples/js/controls/OrbitControls.js",
    "https://cdn.jsdelivr.net/npm/d3-delaunay@6.0.4/dist/d3-delaunay.min.js",
]
# leaflet.min.css 以相對路徑引用的圖檔
LEAFLET_IMG = ["layers.png", "layers-2x.png", "marker-icon.png", "marker-icon-2x.png", "marker-shadow.png"]


def fetch(url, dest):
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=120) as r, open(dest, "wb") as f:
        f.write(r.read())


def icon():
    # 藍色圓角方塊 + 白色集水區輪廓與主流線
    n = 512
    im = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([16, 16, n - 16, n - 16], radius=96, fill=(29, 106, 134, 255))
    basin = [(120, 150), (230, 95), (360, 120), (420, 230), (380, 360), (270, 420), (150, 380), (95, 270)]
    d.polygon(basin, outline=(255, 255, 255, 255), width=18)
    d.line([(260, 410), (255, 330), (215, 260), (225, 190), (290, 140)], fill=(255, 255, 255, 255), width=22, joint="curve")
    d.line([(215, 260), (150, 230)], fill=(255, 255, 255, 255), width=14)
    d.line([(255, 330), (340, 290), (370, 210)], fill=(255, 255, 255, 255), width=14)
    d.ellipse([238, 392, 282, 436], fill=(232, 146, 90, 255))
    im.save(os.path.join(DESK, "icon.png"))
    im.save(os.path.join(DESK, "icon.ico"), sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])


def main():
    subprocess.check_call([sys.executable, os.path.join(HERE, "build_index.py")])
    if os.path.isdir(SITE):
        shutil.rmtree(SITE)
    os.makedirs(SITE)
    for f in ("dem.js", "terrain3d.js"):
        shutil.copy2(os.path.join(REPO, f), SITE)
    shutil.copytree(os.path.join(REPO, "dem"), os.path.join(SITE, "dem"))

    html = open(os.path.join(REPO, "index.html"), encoding="utf-8").read()
    for url in LIBS:
        name = url.split("/")[-1]
        local = f"vendor/{name}"
        fetch(url, os.path.join(SITE, local))
        assert url in html, url
        html = html.replace(url, local)
        print("vendor", name)
    for img in LEAFLET_IMG:
        fetch(f"https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/{img}", os.path.join(VENDOR, "images", img))
    # 桌面版不使用 SRI 與跨來源屬性 (檔案已在本機)
    html = html.replace(' crossorigin="anonymous"', "").replace(' crossorigin=""', "")
    html = html.replace('<div class="sub">', '<div class="sub">桌面版｜', 1)
    open(os.path.join(SITE, "index.html"), "w", encoding="utf-8").write(html)
    icon()
    print("desktop/site 完成")


if __name__ == "__main__":
    main()
