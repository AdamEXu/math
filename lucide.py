import json
from pathlib import Path

ICONS_FILE = Path(__file__).parent / "static" / "lucide" / "icons.json"
_data = json.loads(ICONS_FILE.read_text())
LUCIDE_VERSION = _data["version"]
ICON_MARKUP = {name: entry[0] for name, entry in _data["icons"].items()}
ICON_NAMES = frozenset(ICON_MARKUP)
