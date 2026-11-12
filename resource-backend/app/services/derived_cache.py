"""A small on-disk cache for derived artefacts (meshes), never for decompressed patient images."""

import hashlib
import os
import uuid
from pathlib import Path
from typing import Callable


class DerivedCache:
    def __init__(self, root: Path):
        self.root = Path(root)

    def get_or_build(self, key: str, suffix: str, build: Callable[[], bytes]) -> Path:
        """The cached file for `key`, built on first use.

        The file name is the sha1 of the key. A build is written to a unique temp file and moved
        into place with `os.replace`, so a concurrent reader never sees a partial file; two
        racing builds both succeed and the last one wins with identical content.
        """
        self.root.mkdir(parents=True, exist_ok=True)
        path = self.root / f"{hashlib.sha1(key.encode('utf-8')).hexdigest()}{suffix}"
        if path.is_file():
            return path
        tmp = self.root / f".{path.name}.{uuid.uuid4().hex}.tmp"
        try:
            tmp.write_bytes(build())
            try:
                os.replace(tmp, path)
            except PermissionError:
                # Windows refuses to replace a file another request has open. The key fixes the
                # content, so the existing file is already the right one.
                if not path.is_file():
                    raise
        finally:
            tmp.unlink(missing_ok=True)
        return path
