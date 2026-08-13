#!/usr/bin/env python3
"""
Step 4 - transform raw collected JSON (S3 raw/) into Neptune-loadable CSV
in the Neptune property-graph (Gremlin) load format, written to S3 graph/.

Graph model
-----------
Every node carries a ``displayLabel`` (human-friendly text baked in at
transform time, Requirement 9) and, where relevant, business metadata pulled
from ``hub/business_context.json``.

Nodes
  Account(acct:<id>)            name, displayName, businessUnit, displayLabel
  AgentSpace(space:<id>)        name, account, displayLabel, capability counts
                                (telemetry, pipelines, communications,
                                mcpServers, remoteAgents, webhooks,
                                logDeliveries, users; omitted when unknown)
  Association(assoc:<id>)       serviceId, status, targetKind, displayLabel
  ExternalTarget(ext:<k>:<ref>) kind, ref, displayLabel
  Investigation(inv:<execId>)   summary, account, space, displayLabel
  Recommendation(rec:<id>)      title, status, priority, displayLabel
  Asset(asset:<space>:<id>)     assetType, assetName, account, displayLabel
  AwsService(svc:<name>)        name, displayLabel

Edges
  Account      -HAS_SPACE->        AgentSpace
  AgentSpace   -HAS_ASSOCIATION->  Association
  Association  -TARGETS_ACCOUNT->  Account          (cross-account link)
  Association  -TARGETS_EXTERNAL-> ExternalTarget
  AgentSpace   -HAS_INVESTIGATION->Investigation
  AgentSpace   -HAS_RECOMMENDATION>Recommendation
  AgentSpace   -HAS_ASSET->        Asset
  AgentSpace   -USES_SERVICE->     AwsService       (from associations/journal)
  Investigation-REFERENCES_SERVICE>AwsService       (from journal records)
Shared ExternalTarget / AwsService / Account nodes referenced by spaces in
different accounts are what surface cross-account service relationships.

Label enrichment (Requirement 9)
--------------------------------
``displayLabel`` is derived per node type from the most human-friendly field
available (account/space/service name, asset type+name, truncated investigation
summary / recommendation title). When no such field exists we fall back to a
typed label ``"<Type> …<last 8 of id>"`` (Requirement 9.8). The pure helpers
(:func:`truncate`, :func:`fallback_label`, :func:`display_label_for`) contain no
AWS I/O so they are unit-testable in isolation.
"""
import csv
import io
import json
from _common import CFG, hub_session

BUCKET = CFG["HUB_BUCKET"]

#: Max length of a truncated free-text label (Requirements 9.6, 9.7).
LABEL_MAX = 120

_S3 = None


def s3():
    """Lazily create the hub S3 client so importing this module (e.g. from
    unit tests) never requires AWS credentials or a configured profile."""
    global _S3
    if _S3 is None:
        _S3 = hub_session().client("s3")
    return _S3


nodes = {}  # id -> (label, props dict)
edges = {}  # (from,to,label) -> props dict


def node(nid, label, **props):
    clean = {k: v for k, v in props.items() if v not in (None, "")}
    if nid not in nodes:
        nodes[nid] = (label, clean)
    else:
        # merge: fill in any properties we didn't have yet (e.g. a name that
        # only appears on the account's own record, not on an association ref).
        existing_label, existing = nodes[nid]
        existing.update({k: v for k, v in clean.items() if k not in existing})
        nodes[nid] = (existing_label, existing)


def edge(frm, to, label, **props):
    edges.setdefault((frm, to, label), {}).update({k: v for k, v in props.items() if v})


def read_json(key):
    return json.loads(s3().get_object(Bucket=BUCKET, Key=key)["Body"].read())


def iter_keys(prefix):
    for page in s3().get_paginator("list_objects_v2").paginate(Bucket=BUCKET, Prefix=prefix):
        for o in page.get("Contents", []):
            yield o["Key"]


def target_from_config(cfg):
    """Return (kind, ref, is_aws_account) for an association configuration."""
    for kind, val in (cfg or {}).items():
        if not isinstance(val, dict) or not val:
            continue
        if kind in ("aws", "sourceAws"):
            return "aws", val.get("accountId"), True
        ref = (val.get("repoName") or val.get("owner") or val.get("projectPath")
               or val.get("envId") or val.get("workspaceName") or val.get("workspaceId")
               or val.get("instanceId") or val.get("organizationName")
               or val.get("endpoint") or val.get("accountId") or kind)
        return kind, ref, False
    return None, None, False


# --------------------------------------------------------------------------- #
# Label enrichment (Requirement 9) - pure helpers, no AWS I/O.                 #
# --------------------------------------------------------------------------- #

def truncate(text, limit=LABEL_MAX):
    """Trim free text to at most ``limit`` chars, appending an ellipsis when the
    original was longer (Requirements 9.6, 9.7). The ellipsis counts toward the
    limit so the result never exceeds ``limit`` characters."""
    text = (text or "").strip()
    if len(text) <= limit:
        return text
    return text[: limit - 1].rstrip() + "…"


def fallback_label(label, nid):
    """Typed fallback label ``"<Type> …<last 8 of id>"`` (Requirement 9.8).

    ``nid`` is the prefixed graph id (e.g. ``"acct:345678901234"``); the raw
    entity id is the segment after the final ``:``.
    """
    raw = str(nid).split(":")[-1]
    return f"{label} …{raw[-8:]}"


def is_memory_asset(asset):
    """True for agent 'memory' / 'memory_store' assets. These are by far the most
    numerous asset type and clutter the executive topology graph without value,
    so they are excluded from the graph (mirrored at query time in the web app's
    graphEnrichment.isMemoryAsset)."""
    return str((asset or {}).get("assetType") or "").lower().startswith("memory")


def display_label_for(label, props, nid):
    """Compute a node's human-friendly ``displayLabel`` from its type + props,
    falling back to a typed label when no friendly field is present
    (Requirements 9.1-9.8)."""
    base = None
    if label == "Account":
        base = props.get("displayName") or props.get("name")
    elif label == "AgentSpace":
        base = props.get("name")
    elif label == "Asset":
        parts = [p for p in (props.get("assetType"), props.get("assetName")) if p]
        base = ": ".join(parts) if parts else None
    elif label == "AwsService":
        base = props.get("name")
    elif label == "Investigation":
        base = truncate(props.get("summary"))
    elif label == "Recommendation":
        base = truncate(props.get("title"))
    elif label == "ExternalTarget":
        kind, ref = props.get("kind"), props.get("ref")
        base = f"{kind}: {ref}" if kind and ref else (ref or kind)
    return base or fallback_label(label, nid)


def load_business_context():
    """Load optional ``hub/business_context.json`` display-name / Business_Unit
    overlays. Fails open (empty overlays) when the object is absent or invalid.

    Returns (accountDisplayNames: {id: name}, businessUnitByAccount: {id: bu})."""
    try:
        data = read_json("hub/business_context.json")
    except Exception:
        return {}, {}
    if not isinstance(data, dict):
        return {}, {}
    display = data.get("accountDisplayNames") or {}
    if not isinstance(display, dict):
        display = {}
    bu_by_account = {}
    for unit in data.get("businessUnits") or []:
        if not isinstance(unit, dict):
            continue
        name = unit.get("name")
        if not name:
            continue
        for acc in unit.get("accounts") or []:
            bu_by_account[acc] = name
    return display, bu_by_account


def finalize_labels(display_names, business_units):
    """Overlay business context onto Account nodes and bake a ``displayLabel``
    into every node (Requirement 9). Run after all nodes/props are merged."""
    for nid, (label, props) in nodes.items():
        if label == "Account":
            aid = props.get("accountId") or str(nid).split(":")[-1]
            if aid in display_names:
                props["displayName"] = display_names[aid]
            if aid in business_units:
                props["businessUnit"] = business_units[aid]
        props["displayLabel"] = display_label_for(label, props, nid)


def build():
    display_names, business_units = load_business_context()
    manifest = read_json("raw/_manifest.json")
    for acct in manifest["accounts"]:
        aid = acct["account"]
        node(f"acct:{aid}", "Account", name=acct.get("name"), accountId=aid)
        for sp in acct.get("spaces", []):
            sid = sp["agentSpaceId"]
            # Capability counts (telemetry, pipelines, communications, MCP
            # servers, remote agents, webhooks) plus log-delivery endpoints and
            # operator-app users, baked onto the AgentSpace node so graph
            # queries and chat grounding can surface a space's configuration
            # footprint. A metric the collector recorded as null (UNKNOWN) or
            # that predates capability tracking is OMITTED from the node —
            # node() drops None props — rather than presented as a false 0.
            _counts = sp.get("counts") or {}
            caps = {k: _counts.get(k) for k in (
                "telemetry", "pipelines", "communications", "mcpServers",
                "remoteAgents", "webhooks", "logDeliveries", "users")}
            node(f"space:{sid}", "AgentSpace", name=sp.get("name"), account=aid, **caps)
            edge(f"acct:{aid}", f"space:{sid}", "HAS_SPACE")
            base = f"raw/account={aid}/space={sid}"

            for a in _safe(base + "/associations.json"):
                asid = a.get("associationId", "unknown")
                kind, ref, is_aws = target_from_config(a.get("configuration"))
                node(f"assoc:{asid}", "Association", serviceId=a.get("serviceId"),
                     status=a.get("status"), targetKind=kind)
                edge(f"space:{sid}", f"assoc:{asid}", "HAS_ASSOCIATION")
                if is_aws and ref:
                    node(f"acct:{ref}", "Account", accountId=ref)
                    edge(f"assoc:{asid}", f"acct:{ref}", "TARGETS_ACCOUNT")
                    node("svc:aws", "AwsService", name="aws")
                    edge(f"space:{sid}", "svc:aws", "USES_SERVICE")
                elif kind:
                    node(f"ext:{kind}:{ref}", "ExternalTarget", kind=kind, ref=str(ref))
                    edge(f"assoc:{asid}", f"ext:{kind}:{ref}", "TARGETS_EXTERNAL")

            for a in _safe(base + "/assets.json"):
                aid2 = a.get("assetId")
                # Skip agent "memory" assets — the most numerous asset type; they
                # clutter the executive topology graph without value.
                if is_memory_asset(a):
                    continue
                node(f"asset:{sid}:{aid2}", "Asset", assetType=a.get("assetType"),
                     assetName=(a.get("name") or a.get("assetName")), account=aid)
                edge(f"space:{sid}", f"asset:{sid}:{aid2}", "HAS_ASSET")

            # Incidents (INVESTIGATION backlog tasks) are modeled as
            # Investigation nodes — an incident and an investigation are the
            # same thing in AWS DevOps Agent. The collector writes a `summary`
            # (task title/description) onto each so the label enrichment works.
            for ch in _safe(base + "/incidents.json"):
                ex = ch.get("executionId")
                node(f"inv:{ex}", "Investigation", summary=(ch.get("summary") or "")[:512],
                     account=aid, space=sid)
                edge(f"space:{sid}", f"inv:{ex}", "HAS_INVESTIGATION")
                for rec in ch.get("journalRecords", []):
                    for svc in _services_in(rec):
                        node(f"svc:{svc}", "AwsService", name=svc)
                        edge(f"space:{sid}", f"svc:{svc}", "USES_SERVICE")
                        edge(f"inv:{ex}", f"svc:{svc}", "REFERENCES_SERVICE")

            for r in _safe(base + "/recommendations.json"):
                rid = r.get("recommendationId")
                if not rid:
                    continue
                node(f"rec:{rid}", "Recommendation", title=(r.get("title") or "")[:256],
                     status=r.get("status"), priority=str(r.get("priority")))
                edge(f"space:{sid}", f"rec:{rid}", "HAS_RECOMMENDATION")

    finalize_labels(display_names, business_units)


AWS_SERVICE_HINTS = (
    "ec2", "s3", "lambda", "rds", "dynamodb", "eks", "ecs", "sqs", "sns",
    "cloudwatch", "apigateway", "elasticache", "kinesis", "vpc", "cloudfront",
    "bedrock", "stepfunctions", "route53", "elb", "efs", "fargate",
)


def _services_in(record):
    """Best-effort extraction of AWS service names referenced in a journal record."""
    found = set()
    blob = json.dumps(record, default=str).lower()
    for s in AWS_SERVICE_HINTS:
        if f"\"{s}" in blob or f":{s}:" in blob or f"/{s}/" in blob:
            found.add(s)
    return found


def _safe(key):
    try:
        data = read_json(key)
        return data if isinstance(data, list) else []
    except s3().exceptions.NoSuchKey:
        return []
    except Exception:
        return []


def write_csv():
    prop_keys = {}
    for _, (label, props) in nodes.items():
        for k in props:
            prop_keys[k] = "String"
    ncols = ["~id", "~label"] + sorted(prop_keys)
    nbuf = io.StringIO()
    w = csv.writer(nbuf)
    w.writerow([c + (":String" if c not in ("~id", "~label") else "") for c in ncols])
    for nid, (label, props) in nodes.items():
        w.writerow([nid, label] + [props.get(c, "") for c in ncols[2:]])
    s3().put_object(Bucket=BUCKET, Key="graph/nodes.csv", Body=nbuf.getvalue().encode())

    ebuf = io.StringIO()
    ew = csv.writer(ebuf)
    ew.writerow(["~id", "~from", "~to", "~label"])
    i = 0
    for (frm, to, label), _ in edges.items():
        ew.writerow([f"e{i}", frm, to, label])
        i += 1
    s3().put_object(Bucket=BUCKET, Key="graph/edges.csv", Body=ebuf.getvalue().encode())
    print(f"Wrote s3://{BUCKET}/graph/nodes.csv ({len(nodes)} nodes) and "
          f"graph/edges.csv ({len(edges)} edges)")


def main():
    """Entry point, importable so the refresh pipeline can call it directly."""
    build()
    write_csv()


if __name__ == "__main__":
    main()
