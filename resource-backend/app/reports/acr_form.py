"""The ACR MRI Lexicon Summary Form, as the report renderer needs it.

Section titles, field labels and option titles: the strings that reach the page. Loaded from
`acr_form_table.json`, a verbatim copy of the validator's fixture, which the validator's
frontend test generates from its form and guards. Change it only by copying the validator's
file again, never by editing it here.

The fixture contains clinical em dashes (U+2014) that must be preserved verbatim for PDFs.
Copy it byte for byte; a tool that re-encodes it or adds a BOM corrupts them.

stdlib only, so report tests keep running on a bare host.
"""

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

UNSET = "—"  # must equal template.EM_DASH; tests/test_report_template.py pins it


@dataclass(frozen=True)
class AcrOption:
    """An option in a select field."""

    value: str
    title: str


@dataclass(frozen=True)
class AcrField:
    """A field in a form section."""

    id: str
    label: str
    kind: str
    bind: Optional[str]
    options: tuple[AcrOption, ...]


@dataclass(frozen=True)
class AcrSection:
    """A top-level section of the form."""

    id: str
    title: str
    scope: str
    fields: tuple[AcrField, ...]


def _load_sections() -> tuple[AcrSection, ...]:
    """Load ACR_SECTIONS from the committed fixture."""
    fixture_path = Path(__file__).with_name("acr_form_table.json")
    # Read with utf-8-sig (not utf-8) for defensive tolerance: the fixture should have no BOM
    # (it is valid JSON per RFC 8259), but this catches accidental re-encoding. If someone
    # regenerates via PowerShell's Set-Content or Out-File, a BOM may be added; utf-8-sig
    # silently strips it. If we used plain utf-8, a BOM would fail loudly, which is good
    # for catching mistakes, but utf-8-sig is chosen here to be lenient with the fixture.
    data = json.loads(fixture_path.read_text(encoding="utf-8-sig"))

    sections = []
    for section_data in data:
        fields = []
        for field_data in section_data["fields"]:
            options = tuple(
                AcrOption(value=opt["value"], title=opt["title"]) for opt in field_data["options"]
            )
            fields.append(
                AcrField(
                    id=field_data["id"],
                    label=field_data["label"],
                    kind=field_data["kind"],
                    bind=field_data["bind"],
                    options=options,
                )
            )
        sections.append(
            AcrSection(
                id=section_data["id"],
                title=section_data["title"],
                scope=section_data["scope"],
                fields=tuple(fields),
            )
        )
    return tuple(sections)


ACR_SECTIONS = _load_sections()


def field_of(field_id: str) -> Optional[AcrField]:
    """Return the field with the given id, or None if not found."""
    for section in ACR_SECTIONS:
        for field in section.fields:
            if field.id == field_id:
                return field
    return None


def option_title(field_id: str, value: str) -> str:
    """Return the title for an option in a select field, or the raw value if not found."""
    field = field_of(field_id)
    if field is None:
        return str(value)
    for option in field.options:
        if option.value == value:
            return option.title
    return str(value)


def render_value(field_id: str, value) -> str:
    """Render a value for display in the report.

    Rules:
    - None → UNSET
    - a check field: True → "Yes", False → UNSET
    - a select field: the option's title, falling back to the raw value if unknown
    - a float that is integral → without the .0
    - anything else → str(value)
    """
    if value is None:
        return UNSET

    field = field_of(field_id)
    if field is None:
        # Field not found, just convert to string
        if isinstance(value, float) and value == int(value):
            return str(int(value))
        return str(value)

    # Handle check fields
    if field.kind == "check":
        return "Yes" if value is True else UNSET

    # Handle select fields
    if field.kind == "select":
        return option_title(field_id, value)

    # Handle numeric fields
    if isinstance(value, float) and value == int(value):
        return str(int(value))

    return str(value)
