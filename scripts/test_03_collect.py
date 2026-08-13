"""Unit tests for the single-account collection path in ``03_collect.py``
(webapp task 26.1).

Covers the fan-out entry points used by the refresh Distributed Map worker:
  - ``collect_account_with_client`` builds the manifest entry + per-space counts
    from a devops-agent client, with incidents == investigations (Req 6, 10.9).
  - ``collect_account`` writes ``raw/account=<id>/_account.json`` and returns the
    entry, and on an assume/collection failure records the error and STILL writes
    the summary so a fan-out map treats the account as failed without losing the
    others (Requirement 10.10).

The module under test has a numeric prefix, so it is loaded by path. Setting
PIPELINE_CREDENTIALS_MODE=default before import makes its module-level S3 client
use the ambient chain (no named AWS profile needed in any environment).

Run:  pytest scripts/test_03_collect.py
"""
import importlib.util
import io
import os
import zipfile

os.environ.setdefault("PIPELINE_CREDENTIALS_MODE", "default")

_HERE = os.path.dirname(os.path.abspath(__file__))
_SPEC = importlib.util.spec_from_file_location("collect_mod", os.path.join(_HERE, "03_collect.py"))
cm = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(cm)


def _make_zip(files):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for name, text in files.items():
            z.writestr(name, text)
    return buf.getvalue()


def test_extract_zip_texts_reads_skill_bundle():
    zip_bytes = _make_zip(
        {
            "SKILL.md": "## Overview\nArchitecture summary.",
            "references/components/eks.md": "# EKS cluster",
            "empty/": "",  # directory entry -> skipped
        }
    )
    out = cm.extract_zip_texts(zip_bytes)
    assert out["SKILL.md"].startswith("## Overview")
    assert out["references/components/eks.md"] == "# EKS cluster"
    assert "empty/" not in out  # directory entries are not included


def test_extract_zip_texts_bad_bundle_returns_error():
    out = cm.extract_zip_texts(b"not a zip")
    assert "_error" in out


def test_extract_zip_texts_rejects_non_bytes():
    out = cm.extract_zip_texts({"not": "bytes"})
    assert "_error" in out


class FakeDevOpsAgent:
    """Minimal devops-agent client returning one space with mixed backlog tasks.

    The two associations exercise capability categorization: a GitLab pipeline
    integration (which also carries one webhook) and a plain AWS-account source
    (no capability bucket, never queried for webhooks).
    """

    def list_agent_spaces(self, **_):
        return {"agentSpaces": [{"agentSpaceId": "s1", "name": "space one"}]}

    def get_agent_space(self, **_):
        return {"agentSpaceId": "s1", "name": "space one"}

    def list_associations(self, **_):
        return {
            "associations": [
                {"associationId": "as-git", "configuration": {"gitlab": {"projectPath": "g/p"}}},
                {"associationId": "as-aws", "configuration": {"aws": {"accountId": "999999999999"}}},
            ]
        }

    def list_webhooks(self, agentSpaceId, associationId, **_):
        assert associationId != "as-aws", "AWS associations must not be queried for webhooks"
        return {"webhooks": [{"webhookId": "w1", "webhookType": "gitlab"}]}

    def get_operator_app(self, **_):
        return {
            "operatorAppUrl": "https://example.invalid",
            "idc": {"idcApplicationArn": "arn:aws:sso::123456789012:application/x"},
        }

    def list_assets(self, **_):
        return {"items": [{"assetId": "a1"}]}

    def get_asset_content(self, **_):
        return {"content": "hello"}

    def list_backlog_tasks(self, **_):
        # One INVESTIGATION (an incident) + one unrelated task type.
        return {
            "tasks": [
                {"taskType": "INVESTIGATION", "title": "disk full", "executionId": "e1"},
                {"taskType": "SOMETHING_ELSE"},
            ]
        }

    def list_journal_records(self, **_):
        return {"records": [{"r": 1}]}

    def list_recommendations(self, **_):
        return {"recommendations": [{"x": 1}]}

    def get_account_usage(self, **_):
        return {
            "monthlyAccountInvestigationHours": {"limit": -1, "usage": 1.5},
            "monthlyAccountEvaluationHours": {"limit": -1, "usage": 0.1},
            "monthlyAccountSystemLearningHours": {"limit": -1, "usage": 2.0},
            "monthlyAccountOnDemandHours": {"limit": -1, "usage": 0.5},
            "usagePeriodStartTime": "2026-07-01T00:00:00Z",
            "usagePeriodEndTime": "2026-07-15T12:00:00Z",
        }


class FakeSso:
    """sso-admin fake: two application assignments over one page."""

    def list_application_assignments(self, **kwargs):
        assert kwargs["ApplicationArn"].startswith("arn:aws:sso")
        return {"ApplicationAssignments": [{"PrincipalId": "u1"}, {"PrincipalId": "u2"}]}


class FakeLogs:
    """CloudWatch Logs fake: one delivery source for space s1 with two deliveries."""

    def describe_delivery_sources(self, **_):
        return {
            "deliverySources": [
                {"name": "src-1", "resourceArns": ["arn:aws:aidevops:us-east-1:1:agentspace/s1"]},
                {"name": "src-other", "resourceArns": ["arn:aws:aidevops:us-east-1:1:agentspace/zz"]},
            ]
        }

    def describe_deliveries(self, **_):
        return {
            "deliveries": [
                {"id": "d1", "deliverySourceName": "src-1"},
                {"id": "d2", "deliverySourceName": "src-1"},
                {"id": "d3", "deliverySourceName": "src-other"},
            ]
        }


class Recorder:
    """Captures put(key, obj) calls in place of the module's S3 writer."""

    def __init__(self):
        self.writes = {}

    def __call__(self, key, obj):
        self.writes[key] = obj


def _patch_put(monkey_writes):
    cm.put = monkey_writes  # type: ignore[assignment]


def test_collect_account_with_client_counts_and_entry():
    rec = Recorder()
    original = cm.put
    cm.put = rec
    try:
        entry = cm.collect_account_with_client(
            FakeDevOpsAgent(), "111111111111", "acct-a", logs_c=FakeLogs(), sso_c=FakeSso()
        )
    finally:
        cm.put = original

    assert entry["account"] == "111111111111"
    assert entry["name"] == "acct-a"
    assert entry["error"] is None
    assert len(entry["spaces"]) == 1
    counts = entry["spaces"][0]["counts"]
    assert counts["associations"] == 2
    assert counts["assets"] == 1
    assert counts["recommendations"] == 1
    # incident == investigation: exactly the INVESTIGATION task, same value.
    assert counts["incidents"] == 1
    assert counts["investigations"] == 1
    # Configured capabilities: the GitLab association is a pipeline; the AWS
    # association lands in no capability bucket. All buckets are explicit.
    assert counts["pipelines"] == 1
    assert counts["telemetry"] == 0
    assert counts["communications"] == 0
    assert counts["mcpServers"] == 0
    assert counts["remoteAgents"] == 0
    # One webhook on the GitLab association; two log deliveries for s1; two
    # Identity Center users assigned to the operator app.
    assert counts["webhooks"] == 1
    assert counts["logDeliveries"] == 2
    assert counts["users"] == 2
    # Per-space shards were written under the account prefix.
    assert any(k.endswith("/incidents.json") for k in rec.writes)
    assert "raw/account=111111111111/space=s1/associations.json" in rec.writes
    # The capabilities shard carries the same counts plus provenance detail.
    caps = rec.writes["raw/account=111111111111/space=s1/capabilities.json"]
    assert caps["capabilities"]["pipelines"] == 1
    assert caps["webhooks"]["count"] == 1
    assert caps["operatorApp"] == {"userCount": 2, "mode": "idc"}


def test_collect_account_writes_account_summary(monkeypatch):
    rec = Recorder()
    monkeypatch.setattr(cm, "put", rec)

    class FakeSession:
        def client(self, name):
            return {"devops-agent": FakeDevOpsAgent(), "logs": FakeLogs(), "sso-admin": FakeSso()}[name]

    monkeypatch.setattr(cm, "assume_collector", lambda _aid: FakeSession())

    entry = cm.collect_account("222222222222", "acct-b")

    assert entry["error"] is None
    assert entry["account"] == "222222222222"
    # The per-account summary shard is written (assembly reads these).
    summary_key = "raw/account=222222222222/_account.json"
    assert summary_key in rec.writes
    assert rec.writes[summary_key]["spaces"][0]["counts"]["incidents"] == 1
    # Capability metrics flow through the assumed-role path too.
    assert rec.writes[summary_key]["spaces"][0]["counts"]["logDeliveries"] == 2
    assert rec.writes[summary_key]["spaces"][0]["counts"]["users"] == 2


def test_collect_account_records_error_and_still_writes_summary(monkeypatch):
    rec = Recorder()
    monkeypatch.setattr(cm, "put", rec)

    def boom(_aid):
        raise RuntimeError("assume denied")

    monkeypatch.setattr(cm, "assume_collector", boom)

    entry = cm.collect_account("333333333333", "acct-c")

    # Failure is captured, not raised (per-account isolation, Req 10.10).
    assert entry["error"] is not None
    assert "assume denied" in entry["error"]
    assert entry["spaces"] == []
    # The summary is STILL written so assembly sees the failed account.
    summary_key = "raw/account=333333333333/_account.json"
    assert summary_key in rec.writes
    assert rec.writes[summary_key]["error"] is not None


# --------------------------------------------------------------------------- #
# Capability metrics helpers (telemetry / pipelines / communications / MCP     #
# servers / remote agents / webhooks / log deliveries / operator-app users).   #
# --------------------------------------------------------------------------- #


def test_categorize_capabilities_buckets_every_category():
    assoc = [
        {"configuration": {"dynatrace": {}}},
        {"configuration": {"mcpserverdatadog": {}}},   # telemetry (managed MCP)
        {"configuration": {"github": {}}},
        {"configuration": {"slack": {}}},
        {"configuration": {"pagerduty": {}}},
        {"configuration": {"mcpserver": {}}},
        {"configuration": {"remoteagentsigv4": {}}},
        {"configuration": {"aws": {}}},                # account source: no bucket
        {"configuration": {"eventChannel": {}}},       # webhook carrier: no bucket
        {"not-a-config": True},                        # malformed: skipped
    ]
    counts = cm.categorize_capabilities(assoc)
    assert counts == {
        "telemetry": 2,
        "pipelines": 1,
        "communications": 2,
        "mcpServers": 1,
        "remoteAgents": 1,
    }


def test_categorize_capabilities_empty_is_all_zeros():
    counts = cm.categorize_capabilities([])
    assert set(counts) == set(cm.CAPABILITY_BUCKETS)
    assert all(v == 0 for v in counts.values())


def test_count_webhooks_skips_aws_and_an_error_makes_the_total_unknown():
    class Client:
        def list_webhooks(self, agentSpaceId, associationId, **_):
            if associationId == "boom":
                raise RuntimeError("no permission")
            return {"webhooks": [{"webhookId": "w1", "webhookType": "hmac"}]}

    assoc = [
        {"associationId": "ok", "configuration": {"eventChannel": {}}},
        {"associationId": "boom", "configuration": {"pagerduty": {}}},
        {"associationId": "skipped", "configuration": {"sourceAws": {}}},
        {"configuration": {"gitlab": {}}},  # no associationId: skipped
    ]
    total, details = cm.count_webhooks(Client(), "s1", assoc)
    # One association could not be checked, so a partial count would be a lie:
    # the total is UNKNOWN (None -> JSON null), never a fabricated number.
    assert total is None
    assert {"associationId": "boom", "error": "no permission"} in details


def test_count_webhooks_all_successful_returns_real_total():
    class Client:
        def list_webhooks(self, agentSpaceId, associationId, **_):
            return {"webhooks": [{"webhookId": f"w-{associationId}", "webhookType": "hmac"}]}

    assoc = [
        {"associationId": "a1", "configuration": {"eventChannel": {}}},
        {"associationId": "a2", "configuration": {"gitlab": {}}},
    ]
    total, _ = cm.count_webhooks(Client(), "s1", assoc)
    assert total == 2


def test_operator_app_metrics_non_idc_modes_users_unknown():
    class Client:
        def get_operator_app(self, **_):
            return {"iam": {"operatorAppRoleArn": "arn:aws:iam::1:role/x"}}

    users, info = cm.operator_app_metrics(Client(), FakeSso(), "s1")
    # IAM-mode assignments can't be enumerated: the count is UNKNOWN (None),
    # not 0 — users may well exist.
    assert users is None
    assert info["mode"] == "iam"
    assert "not enumerable" in info["note"]


def test_operator_app_metrics_no_operator_app_is_a_true_zero():
    from botocore.exceptions import ClientError

    class Client:
        def get_operator_app(self, **_):
            raise ClientError(
                {"Error": {"Code": "ResourceNotFoundException", "Message": "no app"}},
                "GetOperatorApp",
            )

    users, info = cm.operator_app_metrics(Client(), FakeSso(), "s1")
    # No operator app configured -> genuinely zero operator-app users.
    assert users == 0
    assert info["note"] == "no operator app configured"


def test_operator_app_metrics_retrieval_error_is_unknown():
    class Client:
        def get_operator_app(self, **_):
            raise RuntimeError("AccessDenied")

    users, info = cm.operator_app_metrics(Client(), FakeSso(), "s1")
    assert users is None
    assert info["mode"] is None
    assert "error" in info


def test_operator_app_metrics_idc_mode_paginates_assignments():
    class PagedSso:
        def __init__(self):
            self.calls = 0

        def list_application_assignments(self, **kwargs):
            self.calls += 1
            if "NextToken" not in kwargs:
                return {"ApplicationAssignments": [{"PrincipalId": "u1"}], "NextToken": "t"}
            return {"ApplicationAssignments": [{"PrincipalId": "u2"}, {"PrincipalId": "u3"}]}

    class Client:
        def get_operator_app(self, **_):
            return {"idc": {"idcApplicationArn": "arn:aws:sso::1:application/x"}}

    sso = PagedSso()
    users, info = cm.operator_app_metrics(Client(), sso, "s1")
    assert users == 3
    assert info == {"mode": "idc"}
    assert sso.calls == 2


def test_count_log_deliveries_maps_sources_to_spaces():
    counts = cm.count_log_deliveries(FakeLogs(), ["s1", "s2"])
    assert counts == {"s1": 2, "s2": 0}


def test_count_log_deliveries_without_client_or_permission_is_unknown():
    # No logs client / a failed lookup means the counts are UNKNOWN (None ->
    # JSON null), never a fabricated 0.
    assert cm.count_log_deliveries(None, ["s1"]) == {"s1": None}

    class Denied:
        def describe_delivery_sources(self, **_):
            raise RuntimeError("AccessDenied")

        def describe_deliveries(self, **_):
            return {"deliveries": []}

    assert cm.count_log_deliveries(Denied(), ["s1"]) == {"s1": None}
