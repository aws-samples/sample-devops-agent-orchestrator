"""Unit tests for the graph label enrichment in ``04_transform_to_graph.py``.

Covers the pure label helpers (Requirements 9.1-9.8): friendly-label selection
per node type, ≤120-char truncation for summaries/titles, business-context
overlay onto Account nodes, and the typed ``"<Type> …<last 8 of id>"`` fallback.

The module under test is named with a numeric prefix, so it is loaded by path
via importlib rather than a plain ``import``. Its S3 client is created lazily,
so importing it here needs no AWS credentials.

Run:  pytest scripts/test_04_transform_to_graph.py
"""
import importlib.util
import os

_HERE = os.path.dirname(os.path.abspath(__file__))
_SPEC = importlib.util.spec_from_file_location(
    "transform_to_graph", os.path.join(_HERE, "04_transform_to_graph.py")
)
tg = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(tg)


# --------------------------------------------------------------------------- #
# truncate (Requirements 9.6, 9.7)                                            #
# --------------------------------------------------------------------------- #

def test_truncate_short_text_unchanged():
    assert tg.truncate("short summary") == "short summary"


def test_truncate_empty_and_none():
    assert tg.truncate("") == ""
    assert tg.truncate(None) == ""


def test_truncate_exactly_at_limit_unchanged():
    text = "x" * tg.LABEL_MAX
    assert tg.truncate(text) == text
    assert len(tg.truncate(text)) == tg.LABEL_MAX


def test_truncate_longer_text_gets_ellipsis_and_stays_within_limit():
    text = "y" * 200
    out = tg.truncate(text)
    assert len(out) <= tg.LABEL_MAX
    assert out.endswith("…")


# --------------------------------------------------------------------------- #
# fallback_label (Requirement 9.8)                                            #
# --------------------------------------------------------------------------- #

def test_fallback_label_uses_type_and_last_8_of_id():
    assert tg.fallback_label("Account", "acct:345678901234") == "Account …78901234"


def test_fallback_label_strips_prefix_and_uses_final_segment():
    # asset ids carry the space in the middle; the entity id is the last segment
    assert tg.fallback_label("Asset", "asset:space-123:abcd1234efgh").endswith("…1234efgh")


# --------------------------------------------------------------------------- #
# display_label_for (Requirements 9.1-9.7)                                     #
# --------------------------------------------------------------------------- #

def test_account_uses_name():
    assert tg.display_label_for("Account", {"name": "Payments"}, "acct:1") == "Payments"


def test_account_display_name_takes_precedence_over_org_name():
    props = {"name": "org-name", "displayName": "Payments Prod"}
    assert tg.display_label_for("Account", props, "acct:1") == "Payments Prod"


def test_agent_space_uses_name():
    assert tg.display_label_for("AgentSpace", {"name": "Prod Space"}, "space:1") == "Prod Space"


def test_asset_uses_type_and_name():
    props = {"assetType": "S3Bucket", "assetName": "logs-bucket"}
    assert tg.display_label_for("Asset", props, "asset:s:1") == "S3Bucket: logs-bucket"


def test_asset_with_only_type():
    assert tg.display_label_for("Asset", {"assetType": "S3Bucket"}, "asset:s:1") == "S3Bucket"


def test_aws_service_uses_name():
    assert tg.display_label_for("AwsService", {"name": "lambda"}, "svc:lambda") == "lambda"


def test_investigation_summary_is_truncated():
    long_summary = "z" * 300
    out = tg.display_label_for("Investigation", {"summary": long_summary}, "inv:exec-1")
    assert len(out) <= tg.LABEL_MAX
    assert out.endswith("…")


def test_recommendation_title_is_truncated():
    long_title = "w" * 300
    out = tg.display_label_for("Recommendation", {"title": long_title}, "rec:r-1")
    assert len(out) <= tg.LABEL_MAX
    assert out.endswith("…")


def test_external_target_uses_kind_and_ref():
    props = {"kind": "github", "ref": "my-repo"}
    assert tg.display_label_for("ExternalTarget", props, "ext:github:my-repo") == "github: my-repo"


def test_missing_friendly_label_falls_back_to_typed_label():
    # Account with no name -> typed fallback (Requirement 9.8)
    assert tg.display_label_for("Account", {}, "acct:345678901234") == "Account …78901234"
    # Association has no friendly field defined -> always fallback
    assert tg.display_label_for("Association", {"status": "ACTIVE"}, "assoc:aabbccddeeff") == (
        "Association …ccddeeff"
    )


# --------------------------------------------------------------------------- #
# finalize_labels: business-context overlay + baked displayLabel               #
# --------------------------------------------------------------------------- #

def _reset_nodes(mapping):
    tg.nodes.clear()
    tg.nodes.update(mapping)


def test_finalize_overlays_display_name_and_business_unit_on_account():
    _reset_nodes({"acct:111": ("Account", {"accountId": "111", "name": "org-111"})})
    tg.finalize_labels({"111": "Payments Prod"}, {"111": "Payments Platform"})
    _, props = tg.nodes["acct:111"]
    assert props["displayName"] == "Payments Prod"
    assert props["businessUnit"] == "Payments Platform"
    assert props["displayLabel"] == "Payments Prod"


def test_finalize_bakes_displaylabel_on_every_node():
    _reset_nodes({
        "space:s1": ("AgentSpace", {"name": "Prod Space"}),
        "svc:lambda": ("AwsService", {"name": "lambda"}),
        "acct:999": ("Account", {"accountId": "999"}),  # no name, no context
    })
    tg.finalize_labels({}, {})
    assert tg.nodes["space:s1"][1]["displayLabel"] == "Prod Space"
    assert tg.nodes["svc:lambda"][1]["displayLabel"] == "lambda"
    # unlabeled account with no overlay -> typed fallback (last segment of id)
    assert tg.nodes["acct:999"][1]["displayLabel"] == "Account …999"


def test_load_business_context_parses_units_and_names(monkeypatch):
    monkeypatch.setattr(tg, "read_json", lambda key: {
        "accountDisplayNames": {"111": "Payments Prod"},
        "businessUnits": [{"name": "Payments Platform", "accounts": ["111", "222"]}],
    })
    display, bu = tg.load_business_context()
    assert display == {"111": "Payments Prod"}
    assert bu == {"111": "Payments Platform", "222": "Payments Platform"}


def test_load_business_context_fails_open_on_error(monkeypatch):
    def boom(key):
        raise RuntimeError("no such key")
    monkeypatch.setattr(tg, "read_json", boom)
    assert tg.load_business_context() == ({}, {})


# --------------------------------------------------------------------------- #
# target_from_config: association -> target extraction (Requirement 9)         #
#                                                                              #
# The transform pulls resource/service targets out of each association's       #
# `configuration` so the graph shows meaningful entities (AWS accounts,        #
# GitHub/GitLab/Datadog targets) rather than bare associations. This drives    #
# TARGETS_ACCOUNT / TARGETS_EXTERNAL edges and cross-account detection.        #
# --------------------------------------------------------------------------- #

def test_target_from_config_none_and_empty():
    assert tg.target_from_config(None) == (None, None, False)
    assert tg.target_from_config({}) == (None, None, False)


def test_target_from_config_aws_account_is_flagged_as_account():
    kind, ref, is_aws = tg.target_from_config({"aws": {"accountId": "123456789012"}})
    assert (kind, ref, is_aws) == ("aws", "123456789012", True)


def test_target_from_config_source_aws_alias_is_also_an_account():
    kind, ref, is_aws = tg.target_from_config({"sourceAws": {"accountId": "111111111111"}})
    assert (kind, ref, is_aws) == ("aws", "111111111111", True)


def test_target_from_config_github_prefers_repo_name():
    kind, ref, is_aws = tg.target_from_config(
        {"github": {"repoName": "org/repo", "owner": "org"}}
    )
    assert (kind, ref, is_aws) == ("github", "org/repo", False)


def test_target_from_config_github_falls_back_to_owner_when_no_repo():
    kind, ref, is_aws = tg.target_from_config({"github": {"owner": "org-only"}})
    assert (kind, ref, is_aws) == ("github", "org-only", False)


def test_target_from_config_gitlab_project_path():
    assert tg.target_from_config({"gitlab": {"projectPath": "grp/proj"}}) == (
        "gitlab",
        "grp/proj",
        False,
    )


def test_target_from_config_datadog_endpoint():
    kind, ref, is_aws = tg.target_from_config(
        {"datadog": {"endpoint": "https://api.datadoghq.com"}}
    )
    assert (kind, ref, is_aws) == ("datadog", "https://api.datadoghq.com", False)


def test_target_from_config_unknown_ref_falls_back_to_kind():
    # No recognised ref field -> ref defaults to the kind itself, not an account.
    assert tg.target_from_config({"custom": {"foo": "bar"}}) == ("custom", "custom", False)


def test_target_from_config_skips_empty_or_non_dict_values():
    # The empty dict for the first key is skipped; the next usable target wins.
    cfg = {"github": {}, "gitlab": {"repoName": "grp/repo"}}
    assert tg.target_from_config(cfg) == ("gitlab", "grp/repo", False)
    # A non-dict value is skipped entirely -> nothing extractable.
    assert tg.target_from_config({"github": "not-a-dict"}) == (None, None, False)


# --------------------------------------------------------------------------- #
# _services_in: AWS services referenced by an investigation journal record     #
#                                                                              #
# Pulls AWS service nodes into the graph from investigation journal records    #
# (best-effort hint matching), which become USES_SERVICE / REFERENCES_SERVICE  #
# edges enriching the topology (Requirement 9).                                #
# --------------------------------------------------------------------------- #

def test_services_in_matches_arn_style_reference():
    # `:s3:` inside an ARN matches the s3 hint.
    assert tg._services_in({"arn": "arn:aws:s3:::my-bucket"}) == {"s3"}


def test_services_in_matches_quoted_key_or_value():
    # A quoted value beginning with the service name (`"lambda...`) matches.
    assert "lambda" in tg._services_in({"resource": "lambda-function-1"})


def test_services_in_matches_path_style_reference():
    assert tg._services_in({"path": "/dynamodb/table/orders"}) == {"dynamodb"}


def test_services_in_finds_multiple_distinct_services():
    record = {"a": "arn:aws:ec2:us-east-1:1:instance/i-1", "b": "\"s3://bucket/key"}
    found = tg._services_in(record)
    assert {"ec2", "s3"} <= found


def test_services_in_returns_empty_set_when_no_service_referenced():
    assert tg._services_in({"note": "nothing operational here"}) == set()


def test_services_in_returns_a_set():
    assert isinstance(tg._services_in({"arn": "arn:aws:lambda:...:fn"}), set)


def test_services_in_handles_non_serializable_values():
    # json.dumps uses default=str, so a datetime-like object must not raise.
    import datetime

    record = {"when": datetime.datetime(2026, 7, 1), "arn": "arn:aws:sqs:us-east-1:1:q"}
    assert "sqs" in tg._services_in(record)


# --------------------------------------------------------------------------- #
# is_memory_asset — memory assets are excluded from the graph                 #
# --------------------------------------------------------------------------- #

def test_is_memory_asset_matches_memory_types():
    assert tg.is_memory_asset({"assetType": "memory"}) is True
    assert tg.is_memory_asset({"assetType": "memory_store"}) is True
    assert tg.is_memory_asset({"assetType": "Memory"}) is True  # case-insensitive


def test_is_memory_asset_excludes_other_types():
    assert tg.is_memory_asset({"assetType": "skill"}) is False
    assert tg.is_memory_asset({"assetType": "artifact"}) is False
    assert tg.is_memory_asset({}) is False
    assert tg.is_memory_asset(None) is False



# --------------------------------------------------------------------------- #
# AgentSpace capability props: build() bakes the per-space capability counts   #
# onto the AgentSpace node. A metric the collector recorded as null (UNKNOWN)  #
# or that predates capability tracking is OMITTED from the node — never baked  #
# in as a false 0.                                                             #
# --------------------------------------------------------------------------- #


def test_build_bakes_known_capability_counts_and_omits_unknowns(monkeypatch):
    manifest = {
        "accounts": [
            {
                "account": "111111111111",
                "name": "acct-a",
                "spaces": [
                    {
                        "agentSpaceId": "s1",
                        "name": "space one",
                        "counts": {
                            "associations": 1,
                            "telemetry": 2,
                            "pipelines": 1,
                            "communications": 0,
                            "mcpServers": 1,
                            "remoteAgents": 0,
                            "webhooks": None,       # retrieval error -> unknown
                            "logDeliveries": None,  # retrieval error -> unknown
                            "users": 4,
                        },
                    },
                    # A pre-capability manifest entry: no capability keys at all.
                    {"agentSpaceId": "s2", "name": "legacy", "counts": {}},
                ],
            }
        ]
    }
    monkeypatch.setattr(tg, "read_json", lambda key, *a, **k: manifest)
    monkeypatch.setattr(tg, "load_business_context", lambda: ({}, {}))
    monkeypatch.setattr(tg, "_safe", lambda key: [])
    tg.nodes.clear()
    tg.edges.clear()
    try:
        tg.build()
        label, props = tg.nodes["space:s1"]
        assert label == "AgentSpace"
        assert props["telemetry"] == 2
        assert props["pipelines"] == 1
        assert props["mcpServers"] == 1
        assert props["users"] == 4
        # Explicit zeros are kept (0 is a real, known value).
        assert props["communications"] == 0
        assert props["remoteAgents"] == 0
        # Unknown metrics are omitted, not presented as 0.
        assert "webhooks" not in props
        assert "logDeliveries" not in props
        # Legacy space (pre-capability manifest): all capability props omitted.
        _, legacy = tg.nodes["space:s2"]
        assert not set(legacy) & {
            "telemetry", "pipelines", "communications", "mcpServers",
            "remoteAgents", "webhooks", "logDeliveries", "users"}
    finally:
        tg.nodes.clear()
        tg.edges.clear()
