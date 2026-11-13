"""Resolve a SPARC dataset held in MinIO into per-cohort object URLs, and read objects."""

import io
import logging
import re

import pandas as pd
from urllib.parse import urljoin, urlparse
from typing import List, Dict, Optional, Sequence
from minio import Minio
from minio.error import S3Error
from app.models.api_models import DatasetSpec
from app.utils.setup import Config


logger = logging.getLogger(__name__)


class MinIOValidationError(Exception):
    """Structured error for MinIO validation failures."""
    def __init__(self, step: str, summary: str, detail: str):
        self.step = step
        self.summary = summary
        self.detail = detail
        super().__init__(summary)


def sample_files(manifest_df: pd.DataFrame, filename_col: str, subject: str, sample_id: str) -> List[str]:
    """The manifest's filenames under `primary/{subject}/{sample_id}/`, in manifest order.

    The trailing `/` makes the sample id a whole path segment, so `sam-1` never matches
    `sam-10`'s folder; anything in front of `primary/` (a `./`) is still allowed.
    """
    folder = re.compile(rf"(^|/)primary/{re.escape(subject)}/{re.escape(sample_id)}/")
    return [f for f in manifest_df[filename_col].astype(str) if folder.search(f)]


def build_sample_type_routes(
    datasets: Sequence[DatasetSpec],
    known_types: Sequence[str],
) -> Dict[str, str]:
    """sample_type -> the one dataset that supplies it.

    Runs before any MinIO round-trip, hence step "config" rather than a 1.x step. Both
    failures it raises used to be silent: a type claimed twice resolved by array order,
    and a misspelt type resolved to None and left the layer quietly empty.
    """
    known = set(known_types)
    routes: Dict[str, str] = {}
    for ds in datasets:
        for sample_type in ds.sample_type:
            if sample_type not in known:
                raise MinIOValidationError(
                    step="config",
                    summary=f"Dataset '{ds.name}' declares unknown sample type '{sample_type}'",
                    detail=(
                        "tool_config.json may only route sample types the app knows how to load. "
                        "Check for a typo - 'model_predicted_LPS_nii' is the input name; "
                        "'model_predicted_nii_LPS' is an output name and is not routable.\n"
                        "Known sample types:\n  " + "\n  ".join(sorted(known))
                    ),
                )
            if sample_type in routes:
                raise MinIOValidationError(
                    step="config",
                    summary=(
                        f"Sample type '{sample_type}' is declared by two datasets: "
                        f"'{routes[sample_type]}' and '{ds.name}'"
                    ),
                    detail=(
                        "Each sample type must name exactly one dataset. Otherwise which file the "
                        "clinician is shown depends on the order of the datasets array. Remove "
                        f"'{sample_type}' from one of the two."
                    ),
                )
            routes[sample_type] = ds.name
    return routes


class MinIOService:
    #: One `Minio` for the whole process, built on first use when no client is injected.
    #: `Minio` wraps a thread-safe urllib3 `PoolManager`, so sharing it across the
    #: threadpool is safe and avoids a connection pool per service instance.
    _shared_client: Minio | None = None

    def __init__(self, client: Minio | None = None):
        self._client = client

    @property
    def client(self) -> Minio:
        if self._client is not None:
            return self._client
        if MinIOService._shared_client is None:
            MinIOService._shared_client = Minio(
                endpoint=Config.MINIO_ENDPOINT,
                access_key=Config.MINIO_ACCESS_KEY,
                secret_key=Config.MINIO_SECRET_KEY,
                secure=Config.MINIO_SECURE,
            )
        return MinIOService._shared_client

    def validate_base_url(self, base_url: str):
        if not base_url.startswith("http"):
            raise MinIOValidationError(
                step="1.1",
                summary=f"Invalid MinIO base URL: '{base_url}'",
                detail=f"URL must start with 'http' or 'https'. Received: '{base_url}'"
            )

    def _extract_bucket_and_path(self, full_url: str) -> tuple[str, str]:
        """
        Extract (bucket, object_path) from a full MinIO URL.
        Example:
            full_url = "http://minio:9000/measurements/primary/sub1/sample1/file.nrrd"
            -> ("measurements", "primary/sub1/sample1/file.nrrd")
        Works with any bucket name - no MINIO_BUCKET config needed.
        """
        parsed = urlparse(full_url)
        # parsed.path = "/measurements/primary/sub1/sample1/file.nrrd"
        parts = parsed.path.lstrip('/').split('/', 1)
        if len(parts) < 2:
            raise ValueError(f"Cannot extract bucket/path from URL: {full_url}")
        return parts[0], parts[1]  # ("measurements", "primary/.../file.nrrd")

    def read_object_bytes(self, url: str) -> bytes | None:
        """An object's raw bytes, or None when it is absent, empty or unreadable.

        Non-raising: an unavailable input is "not supplied", a normal state for an optional
        dataset file, and raising would turn a cohort without one into a 500.
        Callers that need to *open* a volume read it through this and hand the bytes to an
        in-memory reader -- imaging data is never written to disk on the way.
        """
        if not url:
            return None
        response = None
        try:
            bucket, object_path = self._extract_bucket_and_path(url)
            response = self.client.get_object(bucket, object_path)
            raw = response.read()
        except Exception as e:
            logger.warning("could not read %s: %s", url, e)
            return None
        finally:
            if response is not None:
                try:
                    response.close()
                    response.release_conn()
                except Exception:
                    pass
        return raw or None

    def object_identity(self, url: str) -> str:
        """`"<etag>:<size>"` of an object; changes whenever its bytes change."""
        bucket, object_path = self._extract_bucket_and_path(url)
        stat = self.client.stat_object(bucket, object_path)
        return f"{stat.etag}:{stat.size}"

    def fetch_excel(self, url: str) -> pd.DataFrame:
        """Fetch Excel file from MinIO via SDK (supports private bucket)."""
        try:
            bucket, object_path = self._extract_bucket_and_path(url)
            logger.info("fetching bucket=%r path=%r", bucket, object_path)
            response = self.client.get_object(bucket, object_path)
            data = response.read()
            response.close()
            response.release_conn()
            return pd.read_excel(io.BytesIO(data))
        except S3Error as e:
            if e.code == "NoSuchBucket":
                bucket, _ = self._extract_bucket_and_path(url)
                raise MinIOValidationError(
                    step="minio",
                    summary=f"MinIO bucket '{bucket}' does not exist",
                    detail=f"Create the '{bucket}' bucket in MinIO and upload your dataset files."
                )
            elif e.code == "NoSuchKey":
                _, object_path = self._extract_bucket_and_path(url)
                raise MinIOValidationError(
                    step="minio",
                    summary=f"File not found in MinIO: {object_path}",
                    detail=f"The file '{object_path}' does not exist. Please upload the required metadata files to MinIO."
                )
            else:
                raise MinIOValidationError(
                    step="minio",
                    summary=f"MinIO error: {e.code}",
                    detail=f"URL: {url}, Error: {e}"
                )
        except Exception as e:
            raise MinIOValidationError(
                step="minio",
                summary=f"Cannot connect to MinIO or read file",
                detail=f"URL: {url}, Error: {type(e).__name__}: {e}"
            )

    def validate_and_resolve_inputs(
        self,
        public_path: str,
        datasets: Sequence[DatasetSpec],
        cohorts: List[str],
        routes: Dict[str, str]
    ) -> Dict[str, Dict[str, str]]:
        """Validate the datasets and cohorts, then resolve every input to a URL.

        `routes` decides which dataset each sample type comes from; nothing here searches.
        Returns: Dict[cohort, Dict[sample_type, full_url | None]]
        """
        if not public_path.endswith("/"):
            public_path += "/"

        # Pre-fetch metadata for all datasets
        # dataset_name -> {subjects: df, samples: df, manifest: df, url: str}
        ds_meta = {}

        # 1.2 Validate datasets exist (by fetching metadata)
        dataset_names = [ds.name for ds in datasets]
        logger.info("validating %d dataset(s): %s", len(datasets), dataset_names)
        for ds in dataset_names:
            ds_url = urljoin(public_path, f"{ds}/")
            subjects_url = urljoin(ds_url, Config.SUBJECTS_METADATA_PATH)
            samples_url = urljoin(ds_url, Config.SAMPLES_METADATA_PATH)
            manifest_url = urljoin(ds_url, Config.METADATA_PATH)

            logger.info("dataset %r: expecting metadata at %s", ds, ds_url)
            try:
                ds_meta[ds] = {
                    "name": ds,
                    "subjects": self.fetch_excel(subjects_url),
                    "samples": self.fetch_excel(samples_url),
                    "manifest": self.fetch_excel(manifest_url),
                    "url": ds_url
                }
                logger.info("dataset %r: OK", ds)
            except MinIOValidationError:
                raise  # Already structured, pass through
            except Exception as e:
                raise MinIOValidationError(
                    step="1.2",
                    summary=f"Dataset '{ds}' metadata files missing in MinIO",
                    detail=(
                        f"Cannot read metadata for dataset '{ds}'. "
                        f"Expected files:\n"
                        f"  - {subjects_url}\n"
                        f"  - {samples_url}\n"
                        f"  - {manifest_url}\n"
                        f"Error: {e}"
                    )
                )

        # 1.3 Verify subjects.xlsx is well-formed in every dataset. A cohort missing from
        # one dataset's subjects.xlsx is not checked here: some datasets legitimately carry
        # only a subset of cohorts (e.g. a model dataset supplying just an optional file for
        # one subject), and that resolves to None per sample type in step 1.4 instead.
        logger.info("verifying subjects.xlsx structure in %d dataset(s)", len(ds_meta))
        for ds_name, meta in ds_meta.items():
            subjects_df = meta['subjects']
            subject_col = next((c for c in subjects_df.columns if c.lower() == 'subject id'), None)
            if not subject_col:
                raise MinIOValidationError(
                    step="1.3",
                    summary=f"Dataset '{ds_name}': subjects.xlsx missing 'Subject ID' column",
                    detail=f"Found columns: {list(subjects_df.columns)}. Please add a 'Subject ID' column."
                )

            existing_subjects = set(subjects_df[subject_col].astype(str).values)
            logger.info("dataset %r: %d subject(s) in subjects.xlsx", ds_name, len(existing_subjects))

        # 1.4 Resolve inputs. Every Config.INPUTS name gets a key; one the config routes
        # nowhere resolves to None, which is what keeps findings_json and t2_* optional.
        resolved_paths = {cohort: {} for cohort in cohorts}

        for cohort in cohorts:
            for sample_type in Config.INPUTS:
                ds_name = routes.get(sample_type)
                resolved_paths[cohort][sample_type] = (
                    self._resolve_in_dataset(ds_meta[ds_name], cohort, sample_type)
                    if ds_name
                    else None
                )

        return resolved_paths

    def _resolve_in_dataset(self, meta: dict, cohort: str, sample_type: str) -> Optional[str]:
        """Full URL of `cohort`'s `sample_type` file inside one dataset, or None if absent.

        Absent is a normal outcome, not a failure: `findings_json` and the whole t2_* group
        are optional and a dataset that ships none of them must still load.

        Refused rather than picked by order: two rows of `sample_type` for `cohort`, or two
        files in its sample folder. Either way the file shown would depend on a sheet's order.
        """
        samples_df = meta['samples']
        manifest_df = meta['manifest']

        subj_col = next((c for c in samples_df.columns if c.lower() == 'subject id'), None)
        type_col = next((c for c in samples_df.columns if c.lower() == 'sample type'), None)
        sid_col = next((c for c in samples_df.columns if c.lower() == 'sample id'), None)
        if not (subj_col and type_col and sid_col):
            return None  # Malformed samples.xlsx

        match = samples_df[
            (samples_df[subj_col].astype(str) == cohort) &
            (samples_df[type_col] == sample_type)
        ]
        if match.empty:
            return None

        filename_col = next(
            (c for c in manifest_df.columns if c.lower() in ['filename', 'file name']), None
        )
        if not filename_col:
            return None  # Malformed manifest

        if len(match) > 1:
            ids = ", ".join(str(s) for s in match[sid_col])
            raise MinIOValidationError(
                step="1.4",
                summary=(
                    f"Dataset '{meta['name']}': {cohort} has {len(match)} rows of sample type "
                    f"'{sample_type}' ({ids})"
                ),
                detail=(
                    "A dataset routed as the current study holds one row per subject and sample "
                    "type; another year's images belong in a prior dataset."
                ),
            )

        row = match.iloc[0]
        sample_id = str(row[sid_col])
        files = sample_files(manifest_df, filename_col, str(row[subj_col]), sample_id)
        if len(files) > 1:
            raise MinIOValidationError(
                step="1.4",
                summary=f"Dataset '{meta['name']}': sample {sample_id} of {cohort} has {len(files)} files",
                detail="\n".join(files) + (
                    "\nEach sample folder must hold one file; with more, which one is shown "
                    "would depend on the manifest's order."
                ),
            )
        return urljoin(meta['url'], files[0]) if files else None
