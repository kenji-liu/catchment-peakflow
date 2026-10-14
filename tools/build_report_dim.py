"""把「臺中分署轄區溪流整治工程之安全評估及效益分析 第二次期中報告 V1.50」表 2-21～2-23
（引用農水署 2025「建立臺灣東部、本島及離島地區區域無因次降雨強度暨山坡地沉砂設施量體初步探討」）
中部 30 站短延時、長延時、全延時無因次降雨強度公式係數寫入 tools/defaults.json 的 "dim"。

  I(t, T) = I0 · (G + H·log10 T) · A / (t + 55)^C
  短延時 I0 = I60^25、長延時 I0 = I120^25、全延時 I0 = I60^25

用法：python tools/build_report_dim.py <報告.pdf>
報告中頭汴坑、雙崎(2)、惠蓀(2) 的站號誤植，依站名對回氣象署 / 水利署測站清單（記錄在 check 欄）。
"""
import json, os, re, sys, urllib.request

import fitz
from pyproj import Transformer

pdf = fitz.open(sys.argv[1])
sets = {}
for key, page in (("short", 73), ("long", 74), ("full", 75)):
    txt = pdf[page - 1].get_text()
    txt = re.sub(r"(C0F9M|C0H9C)\s*\n\s*0", r"\g<1>0", txt)
    toks = [t.strip() for t in txt.split("\n") if t.strip()]
    i, rows = 0, []
    while i < len(toks):
        if re.fullmatch(r"[0-9A-Z]{6}", toks[i]) and i + 8 < len(toks):
            try:
                nums = [float(x) for x in toks[i + 2:i + 9]]
            except ValueError:
                i += 1; continue
            rows.append({"id": toks[i], "name": toks[i + 1], "I0": nums[0], "A": nums[1], "B": nums[2], "C": nums[3], "G": nums[4], "H": nums[5], "P": nums[6]})
            i += 9
        else:
            i += 1
    sets[key] = rows
    print(key, len(rows), file=sys.stderr)


def get(url):
    with urllib.request.urlopen(url, timeout=120) as r:
        return json.loads(r.read().decode("utf-8-sig"))


cwa = {}
for grp in get("https://codis.cwa.gov.tw/api/station_list")["data"]:
    for s in grp["item"]:
        cwa[s["stationID"]] = (s["stationName"], s["latitude"], s["longitude"], s["altitude"])
tm2 = Transformer.from_crs(3826, 4326, always_xy=True)
wra = {}
for s in get("https://opendata.wra.gov.tw/api/v2/15c166e9-800f-4a81-ba60-0ba61b6c9975?sort=_importdate%20asc&format=JSON"):
    if s.get("x_3826") and s.get("y_3826"):
        lng, lat = tm2.transform(float(s["x_3826"]), float(s["y_3826"]))
        wra[s["stationidentifier"]] = (s["observatoryname"], lat, lng, s.get("elevation") or None)

res = []
for k, r in enumerate(sets["short"]):
    lo, fu = sets["long"][k], sets["full"][k]
    assert lo["name"] == r["name"] == fu["name"], (r, lo, fu)
    sid = r["id"]
    base = re.sub(r"\(\d\)$", "", r["name"])
    src = cwa if sid.startswith("C") else wra
    hit = src.get(sid)
    note = ""
    if not hit or base not in hit[0]:
        # 報告站號可能誤植：依站名在同機關清單中尋找
        cand = [(i, v) for i, v in src.items() if base in v[0]]
        if r["name"].endswith(")"):
            cand2 = [(i, v) for i, v in cand if v[0] == r["name"]]
            cand = cand2 or cand
        note = f"報告站號 {sid}；清單中該站號為「{hit[0] if hit else '無'}」，依站名改用 " + ",".join(f"{i}{v[0]}" for i, v in cand)
        hit = cand[0][1] if len(cand) == 1 else None
        if hit: sid = cand[0][0]
    res.append({
        "id": sid, "rid": r["id"], "name": r["name"], "P": r["P"], "agency": "氣象署" if sid.startswith("C") else "水利署",
        "lat": round(hit[1], 6) if hit else None, "lng": round(hit[2], 6) if hit else None, "alt": hit[3] if hit else None,
        "short": [r["I0"], r["A"], r["C"], r["G"], r["H"]],
        "long": [lo["I0"], lo["A"], lo["C"], lo["G"], lo["H"]],
        "full": [fu["I0"], fu["A"], fu["C"], fu["G"], fu["H"]],
        "check": note,
    })
path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "defaults.json")
d = json.load(open(path, encoding="utf-8"))
d["dim"] = res
json.dump(d, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=0)
for x in res:
    print(x["rid"], x["id"], x["name"], x["lat"], x["lng"], x["check"], file=sys.stderr)
