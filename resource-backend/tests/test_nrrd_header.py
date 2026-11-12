"""Header parsing for the `/headers` endpoint -- NRRD text headers and NIfTI's 348-byte
struct -- exercised against synthetic bytes, no real data files and no imaging library.
"""
import gzip
import struct

import pytest

from app.services.nrrd_header import (
    NeedMoreBytes,
    NrrdHeaderError,
    parse_nifti_header,
    parse_nrrd_header,
    read_key_value,
    split_header,
)

# Mirrors the real registration_1 header measured on the live stack (see task-9-brief.md),
# trimmed of the payload.
REGISTRATION_1_HEADER = (
    b"NRRD0004\n"
    b"# Complete NRRD file format specification at:\n"
    b"# http://teem.sourceforge.net/nrrd/format.html\n"
    b"type: float\n"
    b"dimension: 3\n"
    b"space: left-posterior-superior\n"
    b"sizes: 384 384 104\n"
    b"space directions: (0.88541148859000962,1.8178246154784897e-10,-0.0030339194504499941) "
    b"(3.9771519139884631e-06,0.88541592569389427,0.0011607352046605673) "
    b"(0.0051398120256978784,-0.0019664336492934064,1.4999899051230456)\n"
    b"kinds: domain domain domain\n"
    b"endian: little\n"
    b"encoding: raw\n"
    b"space origin: (-175.54231262207031,-159.94430541992188,-84.435951232910156)\n"
)


class TestSplitHeader:
    def test_splits_at_blank_line(self):
        document = REGISTRATION_1_HEADER + b"\n" + b"PAYLOADBYTES"
        header, offset = split_header(document)
        assert document[offset:] == b"PAYLOADBYTES"
        assert b"sizes: 384 384 104" in header

    def test_missing_terminator_raises(self):
        with pytest.raises(NrrdHeaderError):
            split_header(b"NRRD0004\ntype: float\nsizes: 1 1 1\n")


class TestParseNrrdHeader:
    def test_measured_registration_1_header(self):
        header, _ = split_header(REGISTRATION_1_HEADER + b"\n")
        parsed = parse_nrrd_header(header)
        assert parsed["sizes"] == [384, 384, 104]
        assert parsed["dataType"] == "float32"
        assert parsed["itemsize"] == 4
        assert parsed["encoding"] == "raw"
        assert parsed["space"] == "left-posterior-superior"
        assert parsed["space_origin"] == pytest.approx(
            [-175.54231262207031, -159.94430541992188, -84.435951232910156]
        )
        # spacing = the length of each `space directions` row (its off-diagonal terms are
        # small but non-zero, so this is not simply the row's largest component).
        assert parsed["spacing"][0] == pytest.approx(0.8854166865348815, abs=1e-9)
        assert parsed["spacing"][1] == pytest.approx(0.8854166865348816, abs=1e-9)
        assert parsed["spacing"][2] == pytest.approx(1.5, abs=1e-4)

    def test_uint16_type(self):
        document = (
            b"NRRD0004\n"
            b"type: unsigned short\n"
            b"dimension: 3\n"
            b"sizes: 2 2 2\n"
            b"encoding: raw\n"
        )
        parsed = parse_nrrd_header(document)
        assert parsed["dataType"] == "uint16"
        assert parsed["itemsize"] == 2

    def test_missing_magic_raises(self):
        with pytest.raises(NrrdHeaderError):
            parse_nrrd_header(b"type: float\nsizes: 1 1 1\n")

    def test_unsupported_type_raises(self):
        with pytest.raises(NrrdHeaderError):
            parse_nrrd_header(b"NRRD0004\ntype: block\nsizes: 1 1 1\n")

    def test_missing_sizes_raises(self):
        with pytest.raises(NrrdHeaderError):
            parse_nrrd_header(b"NRRD0004\ntype: float\n")

    def test_missing_space_is_none(self):
        # Not every NRRD sets a "space" -- callers must not mistake an absent field for one
        # whose value happens to be an empty string.
        document = b"NRRD0004\ntype: float\nsizes: 1 1 1\nencoding: raw\n"
        assert parse_nrrd_header(document)["space"] is None

    def test_space_is_not_confused_with_space_origin_or_directions(self):
        # A naive "space" field pattern would also match "space origin:"/"space directions:"
        # lines, since both start with "space". The bare field must resolve to just the
        # space's own value.
        document = (
            b"NRRD0004\n"
            b"type: float\n"
            b"space: right-anterior-superior\n"
            b"sizes: 1 1 1\n"
            b"encoding: raw\n"
            b"space origin: (0,0,0)\n"
        )
        assert parse_nrrd_header(document)["space"] == "right-anterior-superior"


class TestKeyValueFields:
    HEADER = (
        b"NRRD0004\n"
        b"# min is mentioned in this comment and must not match\n"
        b"type: unsigned short\n"
        b"sizes: 4 3 2\n"
        b"encoding: raw\n"
        b"min:=0\n"
        b"max:=2516\n"
        b"space origin: (-170.0,-160.0,-60.0)\n"
    )

    def test_reads_a_key_value_field(self):
        assert read_key_value(self.HEADER, "min") == "0"
        assert read_key_value(self.HEADER, "max") == "2516"

    def test_a_comment_mentioning_the_name_does_not_match(self):
        assert read_key_value(self.HEADER, "min") == "0"

    def test_a_plain_field_is_not_a_key_value_field(self):
        """`encoding:` uses one colon; it must not be readable as `encoding:=`."""
        assert read_key_value(self.HEADER, "encoding") is None

    def test_absent_returns_none_rather_than_a_default(self):
        assert read_key_value(self.HEADER, "windowLow") is None

    def test_whitespace_around_the_value_is_tolerated(self):
        assert read_key_value(b"NRRD0004\nmin:=  12.5  \n", "min") == "12.5"


def _nifti_header_bytes(dims=(384, 384, 104), datatype_code=2, byte_order="<") -> bytes:
    buf = bytearray(348)
    struct.pack_into(byte_order + "i", buf, 0, 348)  # sizeof_hdr
    dim = [3, dims[0], dims[1], dims[2], 1, 1, 1, 1]
    struct.pack_into(byte_order + "8h", buf, 40, *dim)
    struct.pack_into(byte_order + "h", buf, 70, datatype_code)
    return bytes(buf)


class TestParseNiftiHeader:
    def test_raw_uncompressed_header(self):
        parsed = parse_nifti_header(_nifti_header_bytes(dims=(384, 384, 104), datatype_code=2))
        assert parsed["dims"] == [384, 384, 104]
        assert parsed["datatypeCode"] == 2

    def test_big_endian_header(self):
        parsed = parse_nifti_header(
            _nifti_header_bytes(dims=(64, 64, 32), datatype_code=4, byte_order=">")
        )
        assert parsed["dims"] == [64, 64, 32]
        assert parsed["datatypeCode"] == 4

    def test_gzip_prefix_decompresses_far_enough(self):
        # Real masks are gzip'd NIfTI; padding to a realistic size gives the decompressor
        # more than 348 bytes of output from a small compressed prefix, as in production.
        payload = _nifti_header_bytes() + bytes(4 * 1024 * 1024)
        compressed = gzip.compress(payload, compresslevel=6)
        parsed = parse_nifti_header(compressed[:4096])
        assert parsed["dims"] == [384, 384, 104]
        assert parsed["datatypeCode"] == 2

    def test_gzip_prefix_too_short_asks_for_more(self):
        payload = _nifti_header_bytes() + bytes(4 * 1024 * 1024)
        compressed = gzip.compress(payload, compresslevel=6)
        with pytest.raises(NeedMoreBytes):
            parse_nifti_header(compressed[:24])

    def test_bad_sizeof_hdr_raises(self):
        buf = bytearray(348)
        struct.pack_into("<i", buf, 0, 999)
        with pytest.raises(NrrdHeaderError):
            parse_nifti_header(bytes(buf))

    def test_short_raw_payload_asks_for_more(self):
        with pytest.raises(NeedMoreBytes):
            parse_nifti_header(b"\x00" * 100)
