"""The one module that touches WeasyPrint.

Everything else under `app/reports/` is pure and testable on a bare host; this file is where
the system dependency lives, and WeasyPrint is imported only inside `render_report_pdf`, so the
app starts on a host without it (`app.services.report` turns its absence into a 503).

Why WeasyPrint rather than a drawing API: the kinetics curve is inline SVG produced by the
same geometry function as the on-screen chart, so the printed curve and the screen curve
cannot drift apart. A report built by placing primitives would need that geometry
reimplemented in a second dialect.

Fonts are resolved from the image (`fonts-liberation2`, `fonts-dejavu-core`). WeasyPrint
cannot fetch remote fonts, and the slim base image ships almost none — the families in
`report.css` must exist locally or every glyph renders as a box.
"""
from datetime import timezone
from pathlib import Path

from app.reports.template import build_context

_TEMPLATE_DIR = Path(__file__).resolve().parent
_HTML_NAME = "report.html"
_CSS_NAME = "report.css"

_environment = None


def _env():
    """Jinja environment, built once. Autoescape on — case names are user data.

    The SVG fragments are the only thing marked `| safe`, and they are built by
    `app.reports.svg` from escaped values rather than from anything a user typed.
    """
    global _environment
    if _environment is None:
        from jinja2 import Environment, FileSystemLoader, select_autoescape

        _environment = Environment(
            loader=FileSystemLoader(str(_TEMPLATE_DIR)),
            autoescape=select_autoescape(["html"]),
            trim_blocks=True,
            lstrip_blocks=True,
        )
    return _environment


def render_report_html(case, findings, anatomical_withheld="", lesion_images=None, zone=timezone.utc):
    """The report as an HTML string. Useful on its own for debugging the layout.

    `anatomical_withheld` is the reason the AP / transverse / craniocaudal size fields carry
    no value on this case (`app.reports.sizes.anatomical_withheld`). Empty means they are
    printable.

    `lesion_images` is `{finding_id: {"uri": data_uri, "caption": str} | {"reason": str}}`
    from `app.services.report`. Optional so a test can build a report without volumes.

    `zone` is the zone every time is printed in — the requesting reader's (`resolve_zone`).
    """
    context = build_context(case, findings, anatomical_withheld, zone)
    context["lesion_images"] = lesion_images or {}
    return _env().get_template(_HTML_NAME).render(**context)


def render_report_pdf(case, findings, anatomical_withheld="", lesion_images=None, zone=timezone.utc):
    """The report as PDF bytes.

    `base_url` is the package directory so relative URLs in the template and stylesheet
    resolve against it. Nothing is fetched over the network — a report must render the same
    on an air-gapped host as on a connected one. `lesion_images` already carries its image
    data as base64 data URIs, so this holds even with per-finding slice images included.
    """
    from weasyprint import CSS, HTML

    html = render_report_html(case, findings, anatomical_withheld, lesion_images, zone)
    document = HTML(string=html, base_url=str(_TEMPLATE_DIR))
    stylesheet = CSS(filename=str(_TEMPLATE_DIR / _CSS_NAME))
    return document.write_pdf(stylesheets=[stylesheet])
