"""Format-agnostic NIfTI loading.

nibabel selects its decompression codec from the file *extension*, so a plain
(uncompressed) NIfTI saved under a .nii.gz name — or a gzipped payload under a
.nii name — fails to load ("is not a gzip file"). These helpers decide by the
actual gzip magic bytes instead of the filename, so every feature works whether
the source data is .nii or .nii.gz.
"""

import gzip
import nibabel as nib

#: A gzip member always starts with these two bytes.
GZIP_MAGIC = bytes([0x1F, 0x8B])


def _read_payload(path) -> bytes:
    """Return the raw NIfTI bytes, transparently gunzipping if gzip-compressed."""
    with open(str(path), "rb") as f:
        raw = f.read()
    if raw[:2] == GZIP_MAGIC:
        raw = gzip.decompress(raw)
    return raw


def load_nifti_bytes(raw: bytes):
    """Load a NIfTI image from bytes, gunzipping first if they are gzipped.

    The bytes path is the primary one: a caller that already holds the object --
    fetched from MinIO, say -- must never have to spool it through a file to be
    able to read it. Returns a nibabel image (Nifti1Image, falling back to
    Nifti2Image) so callers use .get_fdata()/.affine exactly as with nib.load().
    """
    if raw[:2] == GZIP_MAGIC:
        raw = gzip.decompress(raw)
    try:
        return nib.Nifti1Image.from_bytes(raw)
    except Exception:
        return nib.Nifti2Image.from_bytes(raw)


def load_nifti(path):
    """`load_nifti_bytes` for a NIfTI that is already a file on disk.

    Decides by the actual gzip magic rather than the filename, so a plain NIfTI
    under a .nii.gz name loads the same as a real one.
    """
    return load_nifti_bytes(_read_payload(path))
