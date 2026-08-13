#!/usr/bin/env python3
"""
ListAccounts worker (webapp task 26.2) — first stage of the refresh state
machine.

Pages through AWS Organizations for the active account list and writes it to
``refresh/accounts.json`` in the hub bucket as a JSON array of ``{id, name}``.
The refresh Distributed Map then reads that object as its item source (S3
ItemReader), which keeps the potentially-thousands-of-accounts list off Step
Functions' 256 KB state payload limit (Requirement 10.9).

Org listing must run against the management account, so in the deployed pipeline
this Lambda assumes ``MGMT_ROLE_ARN`` (handled inside ``_common.list_org_accounts``
via the default-credentials path); the hub task role itself only needs
``sts:AssumeRole`` on that one role.
"""
import json

from _common import CFG, hub_session, list_org_accounts

BUCKET = CFG["HUB_BUCKET"]
# Fixed key (single-flight refresh, single admin actor -> no per-run collision).
ACCOUNTS_KEY = "refresh/accounts.json"


def to_items(accounts):
    """Project org accounts to the minimal ``{id, name}`` map items."""
    return [{"id": a["id"], "name": a.get("name")} for a in accounts if a.get("id")]


def handler(event=None, _context=None):
    items = to_items(list_org_accounts())
    hub_session().client("s3").put_object(
        Bucket=BUCKET,
        Key=ACCOUNTS_KEY,
        Body=json.dumps(items).encode(),
        ContentType="application/json",
    )
    # The Distributed Map ItemReader points at this bucket/key; `count` seeds the
    # progress total surfaced by GET /refresh/status (Requirement 10.12).
    return {"bucket": BUCKET, "key": ACCOUNTS_KEY, "count": len(items)}
