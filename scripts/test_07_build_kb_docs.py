"""Unit tests for the business-context logic in ``07_build_kb_docs.py``.

Covers Requirement 5.5: display-name application on account docs, per-
Business_Unit doc emission, and the no-context fallback.

The module under test is named with a numeric prefix, so it is loaded by path
via importlib rather than a plain ``import``. Its S3 client is created lazily,
so importing it here needs no AWS credentials.

Run:  pytest scripts/test_07_build_kb_docs.py
"""
import importlib.util
import os

_HERE = os.path.dirname(os.path.abspath(__file__))
_SPEC = importlib.util.spec_from_file_location(
    "build_kb_docs", os.path.join(_HERE, "07_build_kb_docs.py")
)
kb = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(kb)


# --------------------------------------------------------------------------- #
# load_business_context                                                       #
# --------------------------------------------------------------------------- #

def test_load_business_context_parses_names_and_units(monkeypatch):
    monkeypatch.setattr(kb, "read_json", lambda key, default=None: {
        "accountDisplayNames": {"111": "Payments Prod"},
        "businessUnits": [
            {"name": "Payments Platform", "description": "core", "accounts": ["111", "222"]},
        ],
    })
    display, units = kb.load_business_context()
    assert display == {"111": "Payments Prod"}
    assert units == [
        {"name": "Payments Platform", "description": "core", "accounts": ["111", "222"]},
    ]


def test_load_business_context_absent_fails_open(monkeypatch):
    # read_json returns its default (None) when the object is missing
    monkeypatch.setattr(kb, "read_json", lambda key, default=None: default)
    assert kb.load_business_context() == ({}, [])


def test_load_business_context_skips_malformed_units(monkeypatch):
    monkeypatch.setattr(kb, "read_json", lambda key, default=None: {
        "accountDisplayNames": {"111": "Payments Prod"},
        "businessUnits": [
            {"description": "no name"},          # dropped: missing name
            "not-a-dict",                          # dropped: not a dict
            {"name": "Billing", "accounts": ["333", None]},  # None account filtered
        ],
    })
    display, units = kb.load_business_context()
    assert display == {"111": "Payments Prod"}
    assert units == [{"name": "Billing", "description": "", "accounts": ["333"]}]


def test_load_business_context_non_dict_fails_open(monkeypatch):
    monkeypatch.setattr(kb, "read_json", lambda key, default=None: ["unexpected"])
    assert kb.load_business_context() == ({}, [])


# --------------------------------------------------------------------------- #
# account_label                                                               #
# --------------------------------------------------------------------------- #

def test_account_label_prefers_display_name():
    assert kb.account_label("111", "org-name", {"111": "Payments Prod"}) == "Payments Prod"


def test_account_label_falls_back_to_org_name():
    assert kb.account_label("111", "org-name", {}) == "org-name"


def test_account_label_falls_back_to_raw_id():
    assert kb.account_label("111", None, {}) == "111"


# --------------------------------------------------------------------------- #
# build_account_doc (display-name application)                                #
# --------------------------------------------------------------------------- #

def test_account_doc_uses_display_name_as_primary_label_and_keeps_id():
    acct = {"account": "111", "name": "org-name", "spaces": []}
    doc = kb.build_account_doc(acct, {"111": "Payments Prod"})
    # display name is the primary label; raw id retained for reference
    assert doc.startswith("# AWS account Payments Prod (111)")
    assert "Also known as: org-name" in doc


def test_account_doc_without_context_uses_org_name():
    acct = {"account": "111", "name": "org-name", "spaces": []}
    doc = kb.build_account_doc(acct, {})
    assert doc.startswith("# AWS account org-name (111)")
    assert "Also known as" not in doc


def test_account_doc_includes_free_text_context_when_present():
    acct = {"account": "111", "name": "org-name", "spaces": []}
    doc = kb.build_account_doc(acct, {}, {"111": "Prod payments workloads"})
    assert "**Context:** Prod payments workloads" in doc


def test_account_doc_omits_context_when_absent():
    acct = {"account": "111", "name": "org-name", "spaces": []}
    doc = kb.build_account_doc(acct, {}, {})
    assert "**Context:**" not in doc


def test_account_doc_lists_spaces():
    acct = {"account": "111", "name": "org", "spaces": [
        {"name": "Prod Space", "agentSpaceId": "s-1", "counts": {"investigations": 2}},
    ]}
    doc = kb.build_account_doc(acct, {})
    assert "**Prod Space** (`s-1`)" in doc


# --------------------------------------------------------------------------- #
# build_business_unit_doc (per-BU doc emission)                               #
# --------------------------------------------------------------------------- #

def test_business_unit_doc_lists_accounts_and_spaces():
    unit = {"name": "Payments Platform", "description": "core payments",
            "accounts": ["111", "222"]}
    accounts_by_id = {
        "111": {"account": "111", "name": "org-111", "spaces": [
            {"name": "Prod", "agentSpaceId": "s-1", "counts": {}},
        ]},
        "222": {"account": "222", "name": "org-222", "spaces": []},
    }
    doc = kb.build_business_unit_doc(unit, accounts_by_id, {"111": "Payments Prod"})
    assert doc.startswith("# Business Unit: Payments Platform")
    assert "core payments" in doc
    # display name applied within the BU doc, raw id retained
    assert "## Payments Prod (111)" in doc
    assert "**Prod** (`s-1`)" in doc
    # account with no spaces
    assert "## org-222 (222)" in doc
    assert "No AWS DevOps Agent agent spaces." in doc


def test_business_unit_doc_handles_account_missing_from_manifest():
    unit = {"name": "Billing", "description": "", "accounts": ["999"]}
    doc = kb.build_business_unit_doc(unit, {}, {})
    assert "## 999 (999)" in doc
    assert "No collected data available for this account." in doc


# --------------------------------------------------------------------------- #
# main: end-to-end doc emission with a fake S3 (integration-ish)              #
# --------------------------------------------------------------------------- #

class _FakeS3:
    """Minimal S3 stand-in capturing put_object calls and serving get_object."""

    def __init__(self, objects):
        self._objects = objects  # key -> bytes
        self.puts = {}           # key -> body str

    def get_object(self, Bucket, Key):
        if Key not in self._objects:
            raise KeyError(Key)
        import io
        return {"Body": io.BytesIO(self._objects[Key])}

    def put_object(self, Bucket, Key, Body, ContentType=None):
        self.puts[Key] = Body.decode() if isinstance(Body, bytes) else Body


def _install_fake_s3(monkeypatch, objects):
    fake = _FakeS3(objects)
    monkeypatch.setattr(kb, "_S3", fake)
    monkeypatch.setattr(kb, "s3", lambda: fake)
    return fake


def test_main_emits_business_unit_doc_when_context_present(monkeypatch):
    import json
    manifest = {"region": "us-east-1", "accounts": [
        {"account": "111", "name": "org-111", "spaces": [
            {"name": "Prod", "agentSpaceId": "s-1", "counts": {}},
        ]},
    ]}
    context = {
        "accountDisplayNames": {"111": "Payments Prod"},
        "businessUnits": [{"name": "Payments Platform", "accounts": ["111"]}],
    }
    objects = {
        "raw/_manifest.json": json.dumps(manifest).encode(),
        "hub/business_context.json": json.dumps(context).encode(),
    }
    fake = _install_fake_s3(monkeypatch, objects)
    kb.main()

    prefix = kb.DOCS
    assert f"{prefix}account-111.md" in fake.puts
    # display name applied to account doc
    assert "Payments Prod (111)" in fake.puts[f"{prefix}account-111.md"]
    # per-BU doc emitted with businessUnit metadata
    bu_key = f"{prefix}business-unit-payments-platform.md"
    assert bu_key in fake.puts
    meta = json.loads(fake.puts[bu_key + ".metadata.json"])
    assert meta["metadataAttributes"]["businessUnit"] == "Payments Platform"


def test_main_no_context_emits_no_business_unit_docs(monkeypatch):
    import json
    manifest = {"region": "us-east-1", "accounts": [
        {"account": "111", "name": "org-111", "spaces": []},
    ]}
    objects = {"raw/_manifest.json": json.dumps(manifest).encode()}
    fake = _install_fake_s3(monkeypatch, objects)
    kb.main()

    prefix = kb.DOCS
    assert f"{prefix}account-111.md" in fake.puts
    # falls back to org name (no context)
    assert "org-111 (111)" in fake.puts[f"{prefix}account-111.md"]
    # no business-unit docs
    assert not any(k.startswith(f"{prefix}business-unit-") for k in fake.puts)


# --------------------------------------------------------------------------- #
# Skill / summary-report docs (formerly deferred Task 22)                     #
# --------------------------------------------------------------------------- #

def test_slugify_makes_key_safe_names():
    assert kb.slugify("understanding-agent-space") == "understanding-agent-space"
    assert kb.slugify("My Skill! v2") == "my-skill--v2"
    assert kb.slugify("") == "skill"
    assert kb.slugify(None) == "skill"


def test_build_skill_doc_renders_skill_md_and_references():
    asset = {
        "assetId": "ki-ac01389b",
        "assetType": "skill",
        "metadata": {"name": "understanding-agent-space", "description": "Arch context."},
        "content": {
            "skillFiles": {
                "SKILL.md": "## Overview\nWorkshop account with many projects.",
                "references/components/eks.md": "# EKS cluster\nRuns the platform.",
                "references/components/databrew.md": "# DataBrew\nETL workspace.",
            }
        },
    }
    doc = kb.build_skill_doc("gitlab testing", "210987654321", "sample-user",
                             "558ea3cc", "us-east-1", asset)
    # Header carries space + account + skill name; description included.
    assert "Architecture summary — gitlab testing (558ea3cc)" in doc
    assert "understanding-agent-space" in doc
    assert "Arch context." in doc
    # SKILL.md leads; references follow under their own headings.
    assert "## Overview" in doc
    assert "## Reference: references/components/eks.md" in doc
    assert "## Reference: references/components/databrew.md" in doc
    # SKILL.md content precedes the reference sections.
    assert doc.index("Workshop account") < doc.index("## Reference:")


def test_build_skill_doc_surfaces_extract_error():
    asset = {
        "assetId": "ki-bad",
        "metadata": {"name": "broken-skill"},
        "content": {"skillFiles": {"_error": "zip extract failed: boom"}},
    }
    doc = kb.build_skill_doc("s", "111", "Acct", "sid", "us-east-1", asset)
    assert "Skill content unavailable" in doc
    assert "boom" in doc


def test_activity_counts_filters_capability_metrics_out_of_kb_docs():
    counts = {
        "associations": 2, "assets": 1, "investigations": 1, "incidents": 1,
        "recommendations": 0,
        # UI-only capability metrics: must not leak into KB docs.
        "telemetry": 3, "pipelines": 1, "communications": 2, "mcpServers": 1,
        "remoteAgents": 1, "webhooks": 4, "logDeliveries": 2, "users": 5,
    }
    out = kb.activity_counts(counts)
    assert out == {"associations": 2, "assets": 1, "incidents": 1,
                   "investigations": 1, "recommendations": 0}
    assert kb.activity_counts(None) == {}
