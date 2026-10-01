"""把 tools/defaults.json 注入 tools/index.template.html，輸出網站首頁 index.html。"""
import json, os
here = os.path.dirname(os.path.abspath(__file__))
data = json.load(open(os.path.join(here, "defaults.json"), encoding="utf-8"))
html = open(os.path.join(here, "index.template.html"), encoding="utf-8").read()
assert "/*__DATA__*/null" in html
html = html.replace("/*__DATA__*/null", json.dumps(data, ensure_ascii=False))
open(os.path.join(here, "..", "index.html"), "w", encoding="utf-8").write(html)
print("index.html", len(html), "bytes")
