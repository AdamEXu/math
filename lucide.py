import json
from pathlib import Path

ICONS_FILE = Path(__file__).parent / "static" / "lucide" / "icons.json"
_data = json.loads(ICONS_FILE.read_text())
LUCIDE_VERSION = _data["version"]
ICON_MARKUP = {name: entry[0] for name, entry in _data["icons"].items()}

# Lucide 1.64 renamed these; folders may still store the old names.
for alias, current in {
    "archive-restore": "archive-arrow-up",
    "circle-parking": "circle-letter-p",
    "circle-parking-off": "circle-letter-p-off",
    "square-m": "square-letter-m",
    "square-parking": "square-letter-p",
    "square-parking-off": "square-letter-p-off",
}.items():
    ICON_MARKUP[alias] = ICON_MARKUP[current]

# Dropped in 1.64 with no replacement; keep the 1.61 drawings.
ICON_MARKUP["bold"] = '<path d="M6 12h9a4 4 0 0 1 0 8H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h7a4 4 0 0 1 0 8"/>'
ICON_MARKUP["heading"] = '<path d="M6 12h12"/><path d="M6 20V4"/><path d="M18 20V4"/>'

ICON_NAMES = frozenset(ICON_MARKUP)
