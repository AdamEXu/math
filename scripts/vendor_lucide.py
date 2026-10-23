import json
import sys
from html import escape
from pathlib import Path
from urllib.request import urlopen

VERSION = sys.argv[1] if len(sys.argv) > 1 else "1.61.0"
BASE = f"https://cdn.jsdelivr.net/npm/lucide-static@{VERSION}"
OUT = Path(__file__).resolve().parent.parent / "static" / "lucide" / "icons.json"


def fetch(name):
    with urlopen(f"{BASE}/{name}") as res:
        return json.load(res)


def markup(nodes):
    parts = []
    for tag, attrs in nodes:
        attributes = "".join(f' {key}="{escape(str(value))}"' for key, value in attrs.items())
        parts.append(f"<{tag}{attributes}/>")
    return "".join(parts)


nodes = fetch("icon-nodes.json")
tags = fetch("tags.json")
icons = {name: [markup(nodes[name]), tags.get(name, [])] for name in sorted(nodes)}
OUT.write_text(json.dumps({"version": VERSION, "icons": icons}, separators=(",", ":")))
print(f"Wrote {len(icons)} icons from lucide-static@{VERSION} to {OUT}")
