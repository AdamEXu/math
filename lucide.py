import json
from pathlib import Path

from markupsafe import Markup

ICONS_FILE = Path(__file__).parent / "static" / "lucide" / "icons.json"
_data = json.loads(ICONS_FILE.read_text())
LUCIDE_VERSION = _data["version"]
ICON_MARKUP = {name: entry[0] for name, entry in _data["icons"].items()}
ICON_NAMES = frozenset(ICON_MARKUP)
SVG_ATTRS = (
    'xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"'
    ' stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"'
)


def lucide_svg(name):
    return Markup(f'<svg {SVG_ATTRS} class="lucide lucide-{name}">{ICON_MARKUP.get(name, "")}</svg>')
