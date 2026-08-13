#!/usr/bin/env python3
"""
AssembleManifest worker (webapp task 26.2) — runs after the collect Distributed
Map and merges the per-account shards into the manifest.

Each CollectAccount worker wrote ``raw/account=<id>/_account.json`` (the manifest
entry for that account, including an ``error`` field on failure). This stage
lists those shards, merges them into ``raw/_manifest.json`` with a fresh
``collectedAt``, and returns the failed-account ids.

Because the manifest (the source of Last_Sync_Date) is written ONLY here — after
collection — a failure earlier in the run leaves the previous manifest, and thus
Last_Sync_Date, unchanged (Requirements 10.6, 10.7, 10.8). Failed accounts still
appear in the manifest with their ``error`` set, so a partial run is reflected
rather than silently dropping accounts (Requirement 10.10).
"""
import datetime as dt
import json

from _common import CFG, hub_session

BUCKET = CFG["HUB_BUCKET"]
REGION = CFG["REGION"]
MANIFEST_KEY = "raw/_manifest.json"
ACCOUNT_PREFIX = "raw/account="
ACCOUNT_SUMMARY_SUFFIX = "/_account.json"


def read_account_shards(s3):
    """Read every ``raw/account=<id>/_account.json`` summary into entry dicts."""
    entries = []
    token = None
    while True:
        kwargs = {"Bucket": BUCKET, "Prefix": ACCOUNT_PREFIX}
        if token:
            kwargs["ContinuationToken"] = token
        resp = s3.list_objects_v2(**kwargs)
        for obj in resp.get("Contents", []):
            key = obj["Key"]
            if not key.endswith(ACCOUNT_SUMMARY_SUFFIX):
                continue
            body = s3.get_object(Bucket=BUCKET, Key=key)["Body"].read()
            try:
                entries.append(json.loads(body))
            except (ValueError, TypeError):
                # A corrupt shard shouldn't sink the whole assembly; skip it.
                continue
        if resp.get("IsTruncated"):
            token = resp.get("NextContinuationToken")
        else:
            break
    return entries


def build_manifest(entries, region=REGION, now_iso=None):
    """Pure merge: ordered accounts + collection timestamp (unit tested)."""
    accounts = sorted(entries, key=lambda e: str(e.get("account", "")))
    return {
        "collectedAt": now_iso or dt.datetime.now(dt.timezone.utc).isoformat(),
        "region": region,
        "accounts": accounts,
    }


def handler(event=None, _context=None):
    s3 = hub_session().client("s3")
    entries = read_account_shards(s3)
    manifest = build_manifest(entries)
    s3.put_object(
        Bucket=BUCKET,
        Key=MANIFEST_KEY,
        Body=json.dumps(manifest, default=str).encode(),
        ContentType="application/json",
    )
    failed = [e.get("account") for e in entries if e.get("error")]
    return {
        "accounts": len(entries),
        "failedCount": len(failed),
        "failed": failed,
        "manifestKey": MANIFEST_KEY,
    }
