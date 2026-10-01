"""為 IDF 表中的 Horner 雨量站補上座標，寫入 tools/defaults.json 的 "stloc"。

依備註欄的站號比對：
  氣象署 CODiS 測站清單 https://codis.cwa.gov.tw/api/station_list（WGS84 經緯度）
  水利署所屬雨量站基本資料 https://data.gov.tw/dataset/32729（TWD97 TM2，轉 WGS84）
備註以「代)」結尾者表示 Horner 參數取自代表站，地圖上標在代表站位置。
"""
import json
import os
import re
import urllib.request

from pyproj import Transformer

HERE = os.path.dirname(os.path.abspath(__file__))
CWA = "https://codis.cwa.gov.tw/api/station_list"
WRA = "https://opendata.wra.gov.tw/api/v2/15c166e9-800f-4a81-ba60-0ba61b6c9975?sort=_importdate%20asc&format=JSON"


def get(url):
    with urllib.request.urlopen(url, timeout=120) as r:
        return json.loads(r.read().decode("utf-8-sig"))


def main():
    cwa = {}
    for grp in get(CWA)["data"]:
        for s in grp["item"]:
            cwa[s["stationID"]] = (s["stationName"], s["latitude"], s["longitude"], s["altitude"])
    tm2 = Transformer.from_crs(3826, 4326, always_xy=True)
    wra = {}
    for s in get(WRA):
        if s.get("x_3826") and s.get("y_3826"):
            lng, lat = tm2.transform(float(s["x_3826"]), float(s["y_3826"]))
            wra[s["stationidentifier"]] = (s["observatoryname"], lat, lng, s.get("elevation") or None)

    path = os.path.join(HERE, "defaults.json")
    d = json.load(open(path, encoding="utf-8"))
    stloc, miss = {}, []
    for row in d["idf"]:
        name, note = row[1], row[11] or ""
        hit = None
        for gid in re.findall(r"[0-9A-Z]{5,6}", note):
            if gid in cwa:
                hit = (gid, "氣象署", *cwa[gid]); break
            if gid in wra:
                hit = (gid, "水利署", *wra[gid]); break
        if not hit:
            miss.append(name); continue
        gid, agency, gname, lat, lng, alt = hit
        stloc[name] = {"gid": gid, "gname": gname, "agency": agency, "lat": round(lat, 6), "lng": round(lng, 6),
                       "alt": alt, "sub": bool(re.search(r"代\)", note))}  # 「…站代)」才是代表站替代；「代表站)」不算
    d["stloc"] = stloc
    json.dump(d, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=0)
    print(f"定位 {len(stloc)} 站，未定位 {len(miss)} 站：{miss}")


if __name__ == "__main__":
    main()
