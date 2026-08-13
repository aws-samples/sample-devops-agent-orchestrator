"""Unit tests for the refresh fan-out workers (webapp task 26.2):
``list_accounts_worker`` and ``assemble_manifest_worker``.

Covers the item projection, the pure manifest merge (ordering, timestamp,
failed-account entries preserved), and shard reading over a paginated S3 that
mixes in a non-summary key and a corrupt shard. Modules create their S3 client
lazily; PIPELINE_CREDENTIALS_MODE=default avoids needing a named AWS profile.

Run:  pytest scripts/test_refresh_workers.py
"""
import importlib.util
import io
import json
import os

os.environ.setdefault("PIPELINE_CREDENTIALS_MODE", "default")

_HERE = os.path.dirname(os.path.abspath(__file__))


def _load(mod_name, filename):
    spec = importlib.util.spec_from_file_location(mod_name, os.path.join(_HERE, filename))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


la = _load("list_accounts_worker", "list_accounts_worker.py")
am = _load("assemble_manifest_worker", "assemble_manifest_worker.py")


# --------------------------------------------------------------------------- #
# ListAccounts: to_items                                                      #
# --------------------------------------------------------------------------- #

def test_to_items_projects_id_and_name_and_drops_idless():
    accounts = [
        {"id": "111", "name": "a", "email": "x@y"},
        {"id": "222", "name": None},
        {"name": "no-id"},  # dropped
    ]
    assert la.to_items(accounts) == [
        {"id": "111", "name": "a"},
        {"id": "222", "name": None},
    ]


# --------------------------------------------------------------------------- #
# AssembleManifest: build_manifest (pure)                                     #
# --------------------------------------------------------------------------- #

def test_build_manifest_sorts_accounts_and_sets_fields():
    entries = [
        {"account": "333", "spaces": [], "error": None},
        {"account": "111", "spaces": [], "error": None},
        {"account": "222", "spaces": [], "error": "boom"},
    ]
    m = am.build_manifest(entries, region="us-east-1", now_iso="2026-07-06T00:00:00+00:00")
    assert m["region"] == "us-east-1"
    assert m["collectedAt"] == "2026-07-06T00:00:00+00:00"
    assert [a["account"] for a in m["accounts"]] == ["111", "222", "333"]
    # A failed account is retained in the manifest with its error (Req 10.10).
    failed = [a for a in m["accounts"] if a.get("error")]
    assert failed and failed[0]["account"] == "222"


class FakePagedS3:
    """Fake S3 with a two-page list and byte bodies for get_object."""

    def __init__(self, pages, bodies):
        self._pages = pages
        self._bodies = bodies

    def list_objects_v2(self, **kwargs):
        token = kwargs.get("ContinuationToken")
        idx = 0 if token is None else int(token)
        page = self._pages[idx]
        out = {"Contents": [{"Key": k} for k in page]}
        if idx + 1 < len(self._pages):
            out["IsTruncated"] = True
            out["NextContinuationToken"] = str(idx + 1)
        return out

    def get_object(self, Bucket=None, Key=None):  # noqa: N803 - boto3 kwarg name
        return {"Body": io.BytesIO(self._bodies[Key])}


def test_read_account_shards_filters_and_skips_corrupt():
    pages = [
        [
            "raw/account=111/_account.json",
            "raw/account=111/space=s1/assets.json",  # not a summary -> ignored
        ],
        [
            "raw/account=222/_account.json",
            "raw/account=333/_account.json",  # corrupt body -> skipped
        ],
    ]
    bodies = {
        "raw/account=111/_account.json": json.dumps({"account": "111", "error": None}).encode(),
        "raw/account=222/_account.json": json.dumps({"account": "222", "error": "x"}).encode(),
        "raw/account=333/_account.json": b"{not-json",
    }
    entries = am.read_account_shards(FakePagedS3(pages, bodies))
    got = sorted(e["account"] for e in entries)
    assert got == ["111", "222"]  # 333 skipped (corrupt), assets.json ignored
