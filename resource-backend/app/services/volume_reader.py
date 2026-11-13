"""Read NRRD and NIfTI volumes from bytes, never from a file on disk.

A decompressed patient image is never written to disk (see CLAUDE.md). The obstacle used to
be a belief that nibabel and pynrrd need a path; they do not. pynrrd reads a header and its
data from any binary file object, and nibabel builds an image from a `FileHolder` wrapping
one. This module is where that happens, so no caller has to reach for a temp file again.

Format is decided by the bytes themselves, not by the URL's extension: an object served as
`.nii.gz` is sometimes a plain NIfTI, and sniffing the gzip magic is what stops that being a
confusing "is not a gzip file" failure. A name is still accepted, but only as a tiebreaker
and for the log line.

nibabel and pynrrd are imported inside the functions: they are absent on a bare host, and
this module has to stay importable in the test suite.
"""
import gzip
import io
import logging

logger = logging.getLogger(__name__)

#: NRRD files begin with this magic regardless of encoding.
_NRRD_MAGIC = b"NRRD"
#: gzip member header, so a gzipped NIfTI can be recognised without trusting the name.
_GZIP_MAGIC = b"\x1f\x8b"


def _looks_like_nrrd(data: bytes, name: str) -> bool:
    if data.startswith(_NRRD_MAGIC):
        return True
    # A gzipped NRRD still ends in .nrrd; the magic is hidden behind the compression.
    return not data.startswith(_GZIP_MAGIC) and name.lower().endswith(".nrrd")


def _gunzip_if_needed(data: bytes) -> bytes:
    return gzip.decompress(data) if data.startswith(_GZIP_MAGIC) else data


def read_array(data: bytes | None, name: str = ""):
    """A volume's voxels as a numpy array, or None if the bytes cannot be read.

    None covers every "no volume here" case — nothing supplied, an unreadable object, an
    unsupported format — because each leaves the caller with nothing to measure, and none of
    them is an error the caller can act on differently.
    """
    if not data:
        return None
    try:
        raw = _gunzip_if_needed(data)
        if _looks_like_nrrd(raw, name):
            import nrrd

            with io.BytesIO(raw) as handle:
                header = nrrd.read_header(handle)
                # `index_order` is pinned rather than left to pynrrd's default: this must
                # keep matching what `nrrd.read()` returned before, and a library default
                # that shifted would transpose every volume silently -- wrong statistics,
                # no error.
                return nrrd.read_data(header, handle, index_order="F")

        from app.utils.nifti_io import load_nifti_bytes

        return load_nifti_bytes(raw).get_fdata()
    except Exception as exc:
        logger.warning("could not read %s (%s): %s", name or "<unnamed>", type(exc).__name__, exc)
        return None


def read_canonical(data: bytes | None, name: str = ""):
    """`(voxels, geometry)` in the canonical order (i -> L, j -> P, k -> S) the viewer shows, or
    None if the bytes cannot be read.

    The order and the grid come from the file's own header -- an NRRD's `space` and `space
    directions`, a NIfTI's sform or qform -- through `app.geometry.canonical`, the backend's one
    conversion. An image without a patient orientation is None as well: its voxels cannot be
    put in any order safely, and the viewer refuses it too.
    """
    if not data:
        return None
    try:
        from app.geometry import canonical

        raw = _gunzip_if_needed(data)
        if _looks_like_nrrd(raw, name):
            import nrrd

            from app.services.nrrd_header import parse_nrrd_header, split_header

            header_text, _ = split_header(raw)
            geometry = canonical.nrrd_geometry(parse_nrrd_header(header_text))
            with io.BytesIO(raw) as handle:
                native = nrrd.read_data(nrrd.read_header(handle), handle, index_order="F")
        else:
            from app.utils.nifti_io import load_nifti_bytes

            img = load_nifti_bytes(raw)
            geometry = canonical.nifti_geometry(img)
            native = img.get_fdata()
        transform = canonical.canonical_transform(geometry)
        return canonical.reorient(native, transform), canonical.reoriented_geometry(geometry, transform)
    except Exception as exc:
        logger.warning("could not read %s in the canonical order (%s): %s",
                       name or "<unnamed>", type(exc).__name__, exc)
        return None
