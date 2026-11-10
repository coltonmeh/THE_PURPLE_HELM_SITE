"""Assemble the single-file site: template + engine + data snapshot -> index.html"""
import json
from pathlib import Path
H = Path(__file__).resolve().parent
data = json.loads((H / "data.json").read_text())
page = (H / "template.html").read_text()
page = page.replace("__DATA__", json.dumps(data, separators=(",", ":")).replace("</", "<\\/"))
page = page.replace("__RULES__", (H / "rules.html").read_text())
page = page.replace("__ENGINE__", (H / "engine.js").read_text().replace("</", "<\\/"))
(H / "index.html").write_text(page)
print("index.html", len(page), "bytes")
