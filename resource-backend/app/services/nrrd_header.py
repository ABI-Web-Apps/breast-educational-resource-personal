"""Parsing header bytes for NRRD and NIfTI, without any imaging library.

Both `/api/files/{case}/headers` and the slice endpoint need a volume's shape and voxel
type before touching its pixel data -- the annotation grid's geometry, and the byte math
for a slice's offset and length. Both read those facts from a few KB of header bytes
(NRRD's text header, NIfTI's 348-byte struct), so the parsing lives in one place.

Stdlib only, like `nrrd_transcode.py` -- no MinIO, no SimpleITK, no nibabel. This module
has to stay importable in the test suite on a bare host.
"""
import re
import struct
import zlib

#: NRRD separates header text from voxel data with a blank line.
_TERMINATOR = b"\n\n"

_NIFTI_HEADER_SIZE = 348


class NrrdHeaderError(ValueError):
    """The document is not a header this module can parse."""


class NeedMoreBytes(NrrdHeaderError):
    """A gzip prefix decompressed to fewer bytes than a full NIfTI header needs.

    The caller fetched too small a prefix of a compressed object; it should fetch a larger
    one and retry. Raised instead of guessing, since a header parsed from a truncated
    decompression would silently be garbage rather than fail loudly.
    """


def _field_pattern(name: str) -> re.Pattern:
    return re.compile(
        rb"^" + name.encode("ascii") + rb":[ \t]*(.+?)[ \t]*$",
        re.IGNORECASE | re.MULTILINE,
    )


def _key_value_pattern(name: str) -> re.Pattern:
    # NRRD's key/value syntax ("name:=value") is distinct from a plain field ("name: value",
    # one colon) -- anchoring on ":=" at line start is what keeps a plain `encoding:` field,
    # and a comment line that merely mentions the name, from matching here.
    return re.compile(
        rb"^" + name.encode("ascii") + rb":=[ \t]*(.+?)[ \t]*$",
        re.IGNORECASE | re.MULTILINE,
    )


_SIZES = _field_pattern("sizes")
_TYPE = _field_pattern("type")
_ENCODING = _field_pattern("encoding")
_SPACE_DIRECTIONS = _field_pattern("space directions")
_SPACE_ORIGIN = _field_pattern("space origin")
# Bare "space:" field (e.g. "left-posterior-superior") -- NOT "space directions" or
# "space origin", both of which also start with "space". The pattern anchors on ":" right
# after the field name (see `_field_pattern`), so it does not accidentally match those.
_SPACE = _field_pattern("space")

# NRRD type name -> (dtype name reported to the frontend, bytes per voxel). Covers the
# spellings the format allows; this repo's data uses "float" and "unsigned short".
_NRRD_TYPES = {
    "signed char": ("int8", 1), "int8": ("int8", 1), "int8_t": ("int8", 1),
    "uchar": ("uint8", 1), "unsigned char": ("uint8", 1),
    "uint8": ("uint8", 1), "uint8_t": ("uint8", 1),
    "short": ("int16", 2), "short int": ("int16", 2), "signed short": ("int16", 2),
    "signed short int": ("int16", 2), "int16": ("int16", 2), "int16_t": ("int16", 2),
    "ushort": ("uint16", 2), "unsigned short": ("uint16", 2),
    "unsigned short int": ("uint16", 2), "uint16": ("uint16", 2), "uint16_t": ("uint16", 2),
    "int": ("int32", 4), "signed int": ("int32", 4), "int32": ("int32", 4), "int32_t": ("int32", 4),
    "uint": ("uint32", 4), "unsigned int": ("uint32", 4),
    "uint32": ("uint32", 4), "uint32_t": ("uint32", 4),
    "float": ("float32", 4),
    "double": ("float64", 8),
}


def split_header(document: bytes) -> tuple[bytes, int]:
    """Return (header text, byte offset of the payload) for a raw NRRD document.

    `document` need not be the whole file -- a probe of the first few KB is enough, since
    the header terminator is expected well within that. Raises if it isn't found.
    """
    idx = document.find(_TERMINATOR)
    if idx == -1:
        raise NrrdHeaderError("no header/payload terminator (\\n\\n) found in probe")
    return document[:idx], idx + len(_TERMINATOR)


def _field(header: bytes, pattern: re.Pattern) -> str | None:
    match = pattern.search(header)
    return match.group(1).decode("ascii", "replace").strip() if match else None


def read_key_value(header: bytes, name: str) -> str | None:
    """Value of a `name:=` custom key/value field, or None when the field is absent.

    Distinct from `_field`/`_field_pattern`, which read NRRD's plain `name: value` fields --
    a one-colon field is not readable through this function.
    """
    return _field(header, _key_value_pattern(name))


def _parse_vector(text: str) -> list[float]:
    match = re.search(r"\(([^)]*)\)", text)
    if not match:
        raise NrrdHeaderError(f"not a parseable vector: {text!r}")
    return [float(v) for v in match.group(1).split(",")]


def _parse_vectors(text: str) -> list[list[float] | None]:
    vectors: list[list[float] | None] = []
    for match in re.finditer(r"\(([^)]*)\)|none", text, re.IGNORECASE):
        vectors.append([float(v) for v in match.group(1).split(",")] if match.group(1) is not None else None)
    return vectors


def _vector_length(vector: list[float] | None) -> float | None:
    return None if vector is None else sum(v * v for v in vector) ** 0.5


def parse_nrrd_header(header: bytes) -> dict:
    """Parse an NRRD text header into the facts callers need.

    Returns `sizes` (voxel counts, fastest-varying axis first, i.e. NRRD's own order),
    `dataType`, `itemsize` (bytes per voxel), `encoding`, `space` (e.g.
    "left-posterior-superior", `None` if absent), `space_directions`, `space_origin` and
    `spacing` (the length of each `space directions` row -- the per-axis voxel size).
    """
    if not header.startswith(b"NRRD"):
        raise NrrdHeaderError("not an NRRD document (missing NRRD magic)")

    type_field = _field(header, _TYPE)
    if type_field is None or type_field.lower() not in _NRRD_TYPES:
        raise NrrdHeaderError(f"unsupported or missing NRRD type: {type_field!r}")
    data_type, itemsize = _NRRD_TYPES[type_field.lower()]

    sizes_field = _field(header, _SIZES)
    if sizes_field is None:
        raise NrrdHeaderError("missing sizes field")
    sizes = [int(tok) for tok in sizes_field.split()]

    encoding_field = _field(header, _ENCODING)
    space_field = _field(header, _SPACE)
    space_directions_field = _field(header, _SPACE_DIRECTIONS)
    space_origin_field = _field(header, _SPACE_ORIGIN)

    space_directions = _parse_vectors(space_directions_field) if space_directions_field else None
    space_origin = _parse_vector(space_origin_field) if space_origin_field else None
    spacing = [_vector_length(v) for v in space_directions] if space_directions else None

    return {
        "sizes": sizes,
        "dataType": data_type,
        "itemsize": itemsize,
        "encoding": (encoding_field or "").lower(),
        "space": space_field,
        "space_directions": space_directions,
        "space_origin": space_origin,
        "spacing": spacing,
    }


def parse_nifti_header(payload: bytes) -> dict:
    """dims + datatypeCode from a NIfTI-1 header, decompressing `payload` if it is gzip'd.

    `payload` is a prefix of the stored object -- masks are stored gzip-compressed, so this
    only needs enough compressed bytes to decompress to at least 348 bytes, not the whole
    (potentially large) object. Raises `NeedMoreBytes` when the given prefix decompressed to
    fewer bytes than that, so the caller can fetch a larger prefix and retry -- never guesses
    a header from a truncated decompression.
    """
    if payload[:2] == b"\x1f\x8b":
        decompressor = zlib.decompressobj(16 + zlib.MAX_WBITS)
        try:
            header_bytes = decompressor.decompress(payload, _NIFTI_HEADER_SIZE)
        except zlib.error as exc:
            raise NrrdHeaderError(f"corrupt gzip prefix: {exc}") from exc
        if len(header_bytes) < _NIFTI_HEADER_SIZE:
            raise NeedMoreBytes(
                f"only {len(header_bytes)} decompressed bytes from a {len(payload)}-byte prefix"
            )
    else:
        header_bytes = payload[:_NIFTI_HEADER_SIZE]
        if len(header_bytes) < _NIFTI_HEADER_SIZE:
            raise NeedMoreBytes(f"only {len(header_bytes)} raw bytes available")

    for byte_order in ("<", ">"):
        sizeof_hdr = struct.unpack_from(byte_order + "i", header_bytes, 0)[0]
        if sizeof_hdr == _NIFTI_HEADER_SIZE:
            dim = struct.unpack_from(byte_order + "8h", header_bytes, 40)
            datatype_code = struct.unpack_from(byte_order + "h", header_bytes, 70)[0]
            ndim = dim[0] if 0 < dim[0] <= 7 else 3
            return {"dims": list(dim[1 : 1 + ndim]), "datatypeCode": datatype_code}

    raise NrrdHeaderError("not a recognisable NIfTI-1 header (sizeof_hdr != 348)")
