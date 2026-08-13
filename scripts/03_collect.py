#!/usr/bin/env python3
"""
Step 3 - collect DevOps Agent topology + investigations from every account
and write raw JSON to the hub S3 bucket.

Runs from the hub. For each account it obtains a session (direct creds for
hub/mgmt, assumed DevOpsAgentCollectorRole otherwise), then for every agent
space pulls:

  topology     : agent space, associations, assets (+content), asset types
  incidents    : INVESTIGATION backlog tasks (+ journal records) - in AWS DevOps
                 Agent an "investigation" is the agent's investigation of an
                 operational incident, so incidents == investigations here.
  recommendations: prevention recommendations
  capabilities : per-space counts of configured capabilities (telemetry,
                 pipelines, communications, MCP servers, remote agents,
                 webhooks) derived from association configurations +
                 ListWebhooks, plus the space's CloudWatch Logs delivery count
                 and the number of users assigned to its operator app.
                 A metric that could NOT be retrieved (permission gap, API
                 error, non-enumerable operator-app mode) is recorded as JSON
                 null — UNKNOWN — never as a fabricated 0, so every consumer
                 stays aligned with what actually happened during collection.

Layout in S3:
  raw/account=<id>/space=<spaceId>/agent_space.json
                                   /associations.json
                                   /assets.json
                                   /incidents.json
                                   /recommendations.json
                                   /capabilities.json
  raw/account=<id>/_account.json   <- per-account summary (manifest entry shape)
  raw/_manifest.json

Two entry points share the same per-account logic so the scalable refresh can
fan collection out across accounts (webapp task 26):
  - `collect_account(account_id, name)` collects ONE account and writes its
    per-account shards + `_account.json`. The Distributed Map CollectAccount
    worker Lambda calls this for a single map item.
  - `main()` (this script, run locally / in `10_refresh_all.py`) loops over every
    org account calling `collect_account` and assembles `raw/_manifest.json`.
"""
import io
import json
import zipfile
import datetime as dt
from botocore.exceptions import ClientError
from _common import CFG, hub_session, list_org_accounts, assume_collector

REGION = CFG["REGION"]
BUCKET = CFG["HUB_BUCKET"]
S3 = hub_session().client("s3")


def js(o):
    return json.dumps(o, default=str, indent=2)


def put(key, obj):
    S3.put_object(Bucket=BUCKET, Key=key, Body=js(obj).encode(), ContentType="application/json")


def extract_zip_texts(zip_bytes):
    """Extract the UTF-8 text files from a skill asset's content zip bundle.

    AWS DevOps Agent returns a LEARNED skill's content as ``{"zipFile": <bytes>}``
    — a zip whose ``SKILL.md`` (plus ``references/…`` component docs) is exactly
    the architectural "summary report" the console renders. We extract the text
    entries so they can be rendered into knowledge-base docs; the raw zip bytes
    are dropped (they don't serialize to JSON and aren't needed downstream).
    Returns ``{path: text}`` (or ``{"_error": msg}`` if the bundle can't be read).
    """
    if hasattr(zip_bytes, "read"):
        zip_bytes = zip_bytes.read()
    if not isinstance(zip_bytes, (bytes, bytearray)):
        return {"_error": f"unexpected zipFile type: {type(zip_bytes).__name__}"}
    out = {}
    try:
        with zipfile.ZipFile(io.BytesIO(zip_bytes)) as z:
            for name in z.namelist():
                if name.endswith("/"):
                    continue
                try:
                    out[name] = z.read(name).decode("utf-8", "replace")
                except Exception as e:  # noqa: BLE001 - skip an unreadable entry
                    out[name] = f"<<could not decode: {e}>>"
    except Exception as e:  # noqa: BLE001 - a bad bundle shouldn't fail collection
        return {"_error": f"zip extract failed: {e}"}
    return out


def paginate(fn, list_key, **kwargs):
    out, token = [], None
    while True:
        if token:
            kwargs["nextToken"] = token
        r = fn(**kwargs)
        out += r.get(list_key, [])
        token = r.get("nextToken")
        if not token:
            return out


# ---------------------------------------------------------------------------
# Capability categorization
# ---------------------------------------------------------------------------
# An association's `configuration` carries exactly one service-type key. The
# console groups those service types into capability categories; this mapping
# mirrors that grouping so per-space capability counts match what an operator
# sees when configuring the space. Account sources (aws/sourceAws/azure/
# azureidentity) and eventChannel (the webhook carrier, counted separately via
# ListWebhooks) are deliberately NOT capability buckets.
CAPABILITY_BUCKETS = {
    # Observability providers (Datadog/New Relic/Splunk/Grafana are implemented
    # as managed MCP servers by the API but surfaced as Telemetry in the console).
    "telemetry": {"dynatrace", "mcpservernewrelic", "mcpserverdatadog",
                  "mcpserversplunk", "mcpservergrafana"},
    # Code / CI-CD pipeline sources.
    "pipelines": {"github", "gitlab", "azuredevops"},
    # Chat + ITSM / incident communication channels.
    "communications": {"slack", "servicenow", "pagerduty"},
    # Customer-managed generic MCP servers.
    "mcpServers": {"mcpserver", "mcpserversigv4"},
    # Remote agent integrations.
    "remoteAgents": {"remoteagent", "remoteagentsigv4"},
}

# Associations of these kinds never carry webhooks; skip the ListWebhooks call.
_NON_WEBHOOK_KINDS = {"aws", "sourceAws"}


def categorize_capabilities(associations):
    """Count configured capabilities per category from association configs.

    Returns ``{category: count}`` with an explicit 0 for every bucket so a
    missing capability always renders as 0 downstream.
    """
    counts = {k: 0 for k in CAPABILITY_BUCKETS}
    for a in associations:
        cfg = a.get("configuration")
        if not isinstance(cfg, dict):
            continue
        for key in cfg:
            for bucket, kinds in CAPABILITY_BUCKETS.items():
                if key in kinds:
                    counts[bucket] += 1
    return counts


def count_webhooks(c, sid, associations):
    """Total webhooks configured across a space's associations (best effort).

    ListWebhooks requires (agentSpaceId, associationId); pure AWS-account
    associations never carry webhooks so they are skipped. A per-association
    failure is recorded and skipped rather than failing collection, but it
    makes the total UNKNOWN: the count is returned as ``None`` (JSON null) so
    downstream consumers can distinguish "0 webhooks" from "could not count"
    and never present a false 0.
    """
    total, details, failed = 0, [], False
    for a in associations:
        asid = a.get("associationId")
        cfg = a.get("configuration")
        if not asid or not isinstance(cfg, dict) or set(cfg) & _NON_WEBHOOK_KINDS:
            continue
        try:
            hooks = c.list_webhooks(agentSpaceId=sid, associationId=asid).get("webhooks", [])
        except Exception as e:  # noqa: BLE001 - permission/kind gaps must not fail collection
            details.append({"associationId": asid, "error": str(e)})
            failed = True
            continue
        total += len(hooks)
        if hooks:
            details.append({
                "associationId": asid,
                "webhooks": [{"webhookId": h.get("webhookId"),
                              "webhookType": h.get("webhookType")} for h in hooks],
            })
    return (None if failed else total), details


def operator_app_metrics(c, sso_c, sid):
    """Number of users assigned to the space's operator app (best effort).

    Returns ``(count, info_dict)``:

    - ``count`` — an integer when it could actually be determined — including a
      true 0 when the space simply has no operator app (ResourceNotFound);
      ``None`` (JSON null = UNKNOWN) when it could NOT be determined: a retrieval
      error, an Identity Center listing failure, or a non-enumerable access mode
      (IAM / external IdP).
    """
    try:
        app = c.get_operator_app(agentSpaceId=sid)
    except ClientError as e:
        code = (e.response.get("Error") or {}).get("Code", "")
        if "ResourceNotFound" in code:
            # No operator app configured -> genuinely zero operator-app users.
            return 0, {"mode": None, "note": "no operator app configured"}
        return None, {"mode": None, "error": str(e)}
    except Exception as e:  # noqa: BLE001 - unexpected failure: count is unknown
        return None, {"mode": None, "error": str(e)}
    mode = next((m for m in ("idc", "idp", "iam") if app.get(m)), None)
    info = {"mode": mode}
    app_arn = (app.get("idc") or {}).get("idcApplicationArn")
    if mode != "idc" or not app_arn or sso_c is None:
        if mode in ("idp", "iam"):
            info["note"] = f"user assignments not enumerable for '{mode}' access mode"
        return None, info
    users, token = 0, None
    try:
        while True:
            kwargs = {"ApplicationArn": app_arn}
            if token:
                kwargs["NextToken"] = token
            r = sso_c.list_application_assignments(**kwargs)
            users += len(r.get("ApplicationAssignments", []))
            token = r.get("NextToken")
            if not token:
                break
    except Exception as e:  # noqa: BLE001 - Identity Center not reachable from this account
        info["error"] = str(e)
        return None, info
    return users, info


def count_log_deliveries(logs_c, space_ids):
    """Per-space CloudWatch Logs delivery counts for one account (best effort).

    DevOps Agent log delivery is configured through the CloudWatch Logs vended
    delivery APIs: a delivery source references the agent-space ARN, and each
    delivery (source -> destination endpoint) counts as one delivery endpoint.
    Returns ``{agentSpaceId: count}`` (0 for spaces with none). When the lookup
    is impossible — no logs client or the describe calls fail — every count is
    ``None`` (JSON null = UNKNOWN) so downstream never shows a false 0.
    """
    if logs_c is None:
        return {sid: None for sid in space_ids}
    try:
        sources = paginate(logs_c.describe_delivery_sources, "deliverySources")
        deliveries = paginate(logs_c.describe_deliveries, "deliveries")
    except Exception as e:  # noqa: BLE001 - missing logs permissions must not fail collection
        print(f"    log-delivery lookup skipped: {e}")
        return {sid: None for sid in space_ids}
    counts = {sid: 0 for sid in space_ids}
    source_to_space = {}
    for src in sources:
        for arn in src.get("resourceArns") or []:
            for sid in space_ids:
                if f"agentspace/{sid}" in str(arn):
                    source_to_space[src.get("name")] = sid
    for d in deliveries:
        sid = source_to_space.get(d.get("deliverySourceName"))
        if sid is not None:
            counts[sid] += 1
    return counts


def collect_space(c, account_id, space, sso_c=None):
    sid = space["agentSpaceId"]
    prefix = f"raw/account={account_id}/space={sid}"
    counts = {}

    # ---- topology ----
    try:
        put(f"{prefix}/agent_space.json", c.get_agent_space(agentSpaceId=sid))
    except ClientError as e:
        put(f"{prefix}/agent_space.json", {"error": str(e)})

    assoc = paginate(c.list_associations, "associations", agentSpaceId=sid, maxResults=100)
    put(f"{prefix}/associations.json", assoc)
    counts["associations"] = len(assoc)

    assets = paginate(c.list_assets, "items", agentSpaceId=sid, maxResults=100)
    for a in assets:
        try:
            cont = c.get_asset_content(agentSpaceId=sid, assetId=a["assetId"])
            body = cont.get("content")
            # Skills return a zip bundle ({"zipFile": <bytes>}) — the SKILL.md +
            # references/ inside are the console's "summary report". Extract the
            # text so it can be rendered into KB docs (raw bytes don't serialize).
            if isinstance(body, dict) and "zipFile" in body:
                a["content"] = {"skillFiles": extract_zip_texts(body["zipFile"])}
            else:
                if hasattr(body, "read"):
                    body = body.read()
                if isinstance(body, (bytes, bytearray)):
                    body = body.decode("utf-8", "replace")
                a["content"] = body
        except ClientError as e:
            a["content_error"] = str(e)
    put(f"{prefix}/assets.json", assets)
    counts["assets"] = len(assets)
    counts["skills"] = sum(1 for a in assets if (a.get("assetType") or "") == "skill")

    # ---- incidents (a.k.a. investigations) ----
    # AWS DevOps Agent surfaces incidents as INVESTIGATION backlog tasks (the
    # agent's investigation of an operational incident). This is the concept
    # executives mean by both "incident" and "investigation"; the older
    # list_chats path only returned user-initiated chat sessions (usually none),
    # which is why investigations always looked empty.
    try:
        tasks = paginate(c.list_backlog_tasks, "tasks", agentSpaceId=sid, limit=100)
    except ClientError as e:
        tasks = [{"error": str(e)}]
    incidents = [t for t in tasks if isinstance(t, dict) and t.get("taskType") == "INVESTIGATION"]
    for it in incidents:
        # Convenience summary for the graph/KB (title, else trimmed description).
        it["summary"] = it.get("title") or (it.get("description") or "")[:512]
        ex = it.get("executionId")
        if ex:
            try:
                it["journalRecords"] = paginate(
                    c.list_journal_records, "records",
                    agentSpaceId=sid, executionId=ex, limit=100,
                )
            except ClientError as e:
                it["journalRecords_error"] = str(e)
    put(f"{prefix}/incidents.json", incidents)
    # incident == investigation: record the same count under both names so
    # either term can be surfaced downstream without diverging.
    counts["incidents"] = len(incidents)
    counts["investigations"] = len(incidents)

    try:
        recs = paginate(c.list_recommendations, "recommendations", agentSpaceId=sid, limit=100)
    except ClientError as e:
        recs = [{"error": str(e)}]
    put(f"{prefix}/recommendations.json", recs)
    counts["recommendations"] = len(recs)

    # ---- configured capabilities (counts only; no per-config detail) ----
    capability_counts = categorize_capabilities(assoc)
    counts.update(capability_counts)
    webhook_total, webhook_details = count_webhooks(c, sid, assoc)
    counts["webhooks"] = webhook_total
    user_total, operator_app = operator_app_metrics(c, sso_c, sid)
    counts["users"] = user_total
    # `logDeliveries` is account-scoped (CloudWatch Logs delivery APIs) and is
    # merged in by collect_account_with_client; the placeholder is null
    # (UNKNOWN) so a path that never merges it cannot present a false 0.
    counts.setdefault("logDeliveries", None)
    put(f"{prefix}/capabilities.json", {
        "capabilities": capability_counts,
        "webhooks": {"count": webhook_total, "byAssociation": webhook_details},
        "operatorApp": {"userCount": user_total, **operator_app},
    })

    return counts


def collect_account_capabilities(entry, logs_c):
    """Merge account-scoped capability metrics (log deliveries) into the
    per-space counts of a manifest ``entry`` (in place). An unresolvable
    lookup stays ``None`` (UNKNOWN), never a fabricated 0."""
    space_ids = [sp["agentSpaceId"] for sp in entry["spaces"]]
    if not space_ids:
        return
    deliveries = count_log_deliveries(logs_c, space_ids)
    for sp in entry["spaces"]:
        sp["counts"]["logDeliveries"] = deliveries.get(sp["agentSpaceId"])


def collect_account_with_client(c, account_id, name=None, logs_c=None, sso_c=None):
    """
    Collect every agent space in one account using an already-built
    `devops-agent` client, write the per-account shards, and return the
    manifest entry. Separated from credential assumption so it can be unit
    tested with fake clients. `logs_c` (CloudWatch Logs) and `sso_c`
    (sso-admin) power the log-delivery and operator-app user counts; when
    omitted those counts stay 0.
    """
    entry = {"account": account_id, "name": name, "spaces": [], "error": None}
    spaces = paginate(c.list_agent_spaces, "agentSpaces", maxResults=100)
    print(f"[{account_id}] {name}: {len(spaces)} agent space(s)")
    for sp in spaces:
        counts = collect_space(c, account_id, sp, sso_c=sso_c)
        entry["spaces"].append(
            {"agentSpaceId": sp["agentSpaceId"], "name": sp.get("name"), "counts": counts}
        )
    collect_account_capabilities(entry, logs_c)
    # ---- Account-level monthly usage (GetAccountUsage) ----
    # Usage is per-account, not per-space. Capture the current month's hours
    # alongside the spaces so the webapp can surface it per account/BU/org.
    try:
        usage = c.get_account_usage()
        entry["usage"] = {
            "investigationHours": usage.get("monthlyAccountInvestigationHours", {}).get("usage", 0),
            "evaluationHours": usage.get("monthlyAccountEvaluationHours", {}).get("usage", 0),
            "systemLearningHours": usage.get("monthlyAccountSystemLearningHours", {}).get("usage", 0),
            "onDemandHours": usage.get("monthlyAccountOnDemandHours", {}).get("usage", 0),
            "periodStart": str(usage.get("usagePeriodStartTime", "")),
            "periodEnd": str(usage.get("usagePeriodEndTime", "")),
        }
    except Exception as e:  # noqa: BLE001 - usage is best effort
        entry["usage"] = None
        print(f"    usage lookup skipped: {e}")
    for sp in entry["spaces"]:
        print(f"    - {sp['agentSpaceId']} ({sp.get('name')}): {sp['counts']}")
    return entry


def collect_account(account_id, name=None):
    """
    Collect a SINGLE account end-to-end: assume the collector role, collect all
    of its spaces, write the per-account shards + `raw/account=<id>/_account.json`
    summary, and return the manifest entry.

    Best-effort by contract: any failure is captured in the returned entry's
    `error` field (and persisted in `_account.json`) so a fan-out map can treat
    this account as failed WITHOUT losing the accounts that succeeded (webapp
    Requirement 10.10). Always writes `_account.json` so assembly sees the
    account even on failure.
    """
    try:
        sess = assume_collector(account_id)
        c = sess.client("devops-agent")
        logs_c = sess.client("logs")
        sso_c = sess.client("sso-admin")
        entry = collect_account_with_client(c, account_id, name, logs_c=logs_c, sso_c=sso_c)
    except Exception as e:  # noqa: BLE001 - record and continue (per-account isolation)
        entry = {"account": account_id, "name": name, "spaces": [], "error": f"{type(e).__name__}: {e}"}
        print(f"[{account_id}] {name}: FAILED - {entry['error']}")
    put(f"raw/account={account_id}/_account.json", entry)
    return entry


def main():
    accounts = list_org_accounts()
    manifest = {"collectedAt": dt.datetime.now(dt.timezone.utc).isoformat(), "region": REGION, "accounts": []}
    for acct in accounts:
        entry = collect_account(acct["id"], acct.get("name"))
        manifest["accounts"].append(entry)
    put("raw/_manifest.json", manifest)
    print(f"\nManifest written to s3://{BUCKET}/raw/_manifest.json")


if __name__ == "__main__":
    main()
