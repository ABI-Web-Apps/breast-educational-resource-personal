"""In-memory record of the assays the frontend has configured.

Nothing is persisted: a backend restart empties it and the frontend re-posts its
tool config.
"""

import threading
from dataclasses import dataclass, field
from typing import Dict, Optional


@dataclass(frozen=True)
class ResolvedAssay:
    uuid: str
    base_url: str
    #: cohort -> sample type -> object URL (None when the cohort has no such sample)
    cohorts: Dict[str, Dict[str, Optional[str]]] = field(default_factory=dict)


class AssayRegistry:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._assays: Dict[str, ResolvedAssay] = {}

    def put(self, assay: ResolvedAssay) -> None:
        """Store an assay, replacing any earlier one with the same uuid."""
        with self._lock:
            self._assays[assay.uuid] = assay

    def get(self, assay_uuid: str) -> Optional[ResolvedAssay]:
        with self._lock:
            return self._assays.get(assay_uuid)

    def clear(self) -> None:
        with self._lock:
            self._assays.clear()


registry = AssayRegistry()
