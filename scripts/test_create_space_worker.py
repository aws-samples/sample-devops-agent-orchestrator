"""Unit tests for the CreateAgentSpace worker (Admin-only POST /spaces compute).

Covers the pure `create_space` result mapping — success, name/description
validation, access-denied (collector role lacks create permission), name
conflict, and other client errors — plus the handler's tolerant event field
extraction. `assume_collector` is monkeypatched so no AWS calls are made.

Run:  pytest scripts/test_create_space_worker.py
"""
import importlib.util
import os

from botocore.exceptions import ClientError

os.environ.setdefault("PIPELINE_CREDENTIALS_MODE", "default")

_HERE = os.path.dirname(os.path.abspath(__file__))


def _load(mod_name, filename):
    spec = importlib.util.spec_from_file_location(mod_name, os.path.join(_HERE, filename))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


w = _load("create_space_worker", "create_space_worker.py")


class FakeClient:
    """A fake devops-agent client whose create/associate calls are scriptable."""

    def __init__(self, *, result=None, error_code=None, assoc_error_code=None,
                 operator_error_code=None):
        self._result = result
        self._error_code = error_code
        self._assoc_error_code = assoc_error_code
        self._operator_error_code = operator_error_code
        self.calls = []  # create_agent_space calls
        self.assoc_calls = []  # associate_service calls
        self.operator_calls = []  # enable_operator_app calls

    def create_agent_space(self, **kwargs):
        self.calls.append(kwargs)
        if self._error_code:
            raise ClientError(
                {"Error": {"Code": self._error_code, "Message": "boom"}},
                "CreateAgentSpace",
            )
        return {"agentSpace": self._result}

    def associate_service(self, **kwargs):
        self.assoc_calls.append(kwargs)
        if self._assoc_error_code:
            raise ClientError(
                {"Error": {"Code": self._assoc_error_code, "Message": "assoc boom"}},
                "AssociateService",
            )
        return {"association": {"associationId": "assoc-1", "serviceId": "aws"}}

    def enable_operator_app(self, **kwargs):
        self.operator_calls.append(kwargs)
        if self._operator_error_code:
            raise ClientError(
                {"Error": {"Code": self._operator_error_code, "Message": "operator boom"}},
                "EnableOperatorApp",
            )
        return {"agentSpaceId": kwargs.get("agentSpaceId"), "operatorAppUrl": "https://example"}


class FakeSession:
    def __init__(self, client):
        self._client = client

    def client(self, _name):
        return self._client


def _patch(monkeypatch, client):
    monkeypatch.setattr(w, "assume_collector", lambda _aid: FakeSession(client))


def test_create_space_success_attaches_primary_account(monkeypatch):
    # Treat the target as a non-hub account so the conventional monitor role arn
    # is used (independent of any ambient HUB_ACCOUNT_ID in the environment).
    monkeypatch.setitem(w.CFG, "HUB_ACCOUNT_ID", "000000000000")
    client = FakeClient(result={"agentSpaceId": "as-123", "name": "devops-agent-111"})
    _patch(monkeypatch, client)
    out = w.create_space("111111111111", "devops-agent-111", "desc")
    assert out["ok"] is True
    assert out["agentSpaceId"] == "as-123"
    assert out["primaryAccountConfigured"] is True
    assert out["webOperatorEnabled"] is True
    assert "warning" not in out
    # description forwarded only when provided
    assert client.calls == [{"name": "devops-agent-111", "description": "desc"}]
    # The hosting account is attached as the monitor (primary) account.
    assert len(client.assoc_calls) == 1
    assoc = client.assoc_calls[0]
    assert assoc["serviceId"] == "aws"
    assert assoc["configuration"]["aws"]["accountId"] == "111111111111"
    assert assoc["configuration"]["aws"]["accountType"] == "monitor"
    assert assoc["configuration"]["aws"]["assumableRoleArn"].endswith(
        ":role/DevOpsAgentSpaceMonitorRole"
    )
    # Web operator access is enabled with the IAM auth flow + operator-app role.
    assert len(client.operator_calls) == 1
    op = client.operator_calls[0]
    assert op["agentSpaceId"] == "as-123"
    assert op["authFlow"] == "iam"
    assert op["operatorAppRoleArn"].endswith(":role/DevOpsAgentOperatorAppRole")


def test_web_operator_can_be_disabled(monkeypatch):
    monkeypatch.setitem(w.CFG, "HUB_ACCOUNT_ID", "000000000000")
    client = FakeClient(result={"agentSpaceId": "as-123", "name": "n"})
    _patch(monkeypatch, client)
    out = w.create_space("111111111111", "n", enable_web_operator=False)
    assert out["ok"] is True
    assert "webOperatorEnabled" not in out
    assert client.operator_calls == []


def test_web_operator_failure_is_a_warning_not_an_error(monkeypatch):
    monkeypatch.setitem(w.CFG, "HUB_ACCOUNT_ID", "000000000000")
    client = FakeClient(
        result={"agentSpaceId": "as-9", "name": "n"}, operator_error_code="AccessDeniedException"
    )
    _patch(monkeypatch, client)
    out = w.create_space("222222222222", "n")
    # Space + primary account still fine; web operator failure is a warning.
    assert out["ok"] is True
    assert out["primaryAccountConfigured"] is True
    assert out["webOperatorEnabled"] is False
    assert "AccessDeniedException" in out["warning"]


def test_hub_account_without_operator_role_env_warns(monkeypatch):
    monkeypatch.setitem(w.CFG, "HUB_ACCOUNT_ID", "999999999999")
    monkeypatch.setenv("AGENT_MONITOR_ROLE_ARN", "arn:aws:iam::999999999999:role/HubMonitor")
    monkeypatch.delenv("AGENT_OPERATOR_ROLE_ARN", raising=False)
    client = FakeClient(result={"agentSpaceId": "as-h", "name": "hub"})
    _patch(monkeypatch, client)
    out = w.create_space("999999999999", "hub")
    assert out["webOperatorEnabled"] is False
    assert "AGENT_OPERATOR_ROLE_ARN" in out["warning"]
    # No operator enablement attempted when no operator role is available.
    assert client.operator_calls == []


def test_hub_account_uses_operator_role_arn_env(monkeypatch):
    monkeypatch.setitem(w.CFG, "HUB_ACCOUNT_ID", "999999999999")
    monkeypatch.setenv("AGENT_MONITOR_ROLE_ARN", "arn:aws:iam::999999999999:role/HubMonitor")
    monkeypatch.setenv("AGENT_OPERATOR_ROLE_ARN", "arn:aws:iam::999999999999:role/HubOperator")
    client = FakeClient(result={"agentSpaceId": "as-h", "name": "hub"})
    _patch(monkeypatch, client)
    out = w.create_space("999999999999", "hub")
    assert out["webOperatorEnabled"] is True
    assert client.operator_calls[0]["operatorAppRoleArn"] == (
        "arn:aws:iam::999999999999:role/HubOperator"
    )


def test_create_space_omits_empty_description(monkeypatch):
    client = FakeClient(result={"agentSpaceId": "as-1", "name": "n"})
    _patch(monkeypatch, client)
    w.create_space("111111111111", "n")
    assert client.calls == [{"name": "n"}]


def test_association_failure_is_a_warning_not_an_error(monkeypatch):
    monkeypatch.setitem(w.CFG, "HUB_ACCOUNT_ID", "000000000000")
    client = FakeClient(
        result={"agentSpaceId": "as-9", "name": "n"}, assoc_error_code="ValidationException"
    )
    _patch(monkeypatch, client)
    out = w.create_space("222222222222", "n")
    # Space still created; association failure is surfaced as a warning.
    assert out["ok"] is True
    assert out["primaryAccountConfigured"] is False
    assert "ValidationException" in out["warning"]


def test_hub_account_without_monitor_role_env_warns(monkeypatch):
    monkeypatch.setitem(w.CFG, "HUB_ACCOUNT_ID", "999999999999")
    monkeypatch.delenv("AGENT_MONITOR_ROLE_ARN", raising=False)
    client = FakeClient(result={"agentSpaceId": "as-h", "name": "hub"})
    _patch(monkeypatch, client)
    out = w.create_space("999999999999", "hub")
    assert out["ok"] is True
    assert out["primaryAccountConfigured"] is False
    assert "AGENT_MONITOR_ROLE_ARN" in out["warning"]
    # No association attempted when no role is available.
    assert client.assoc_calls == []


def test_hub_account_uses_monitor_role_arn_env(monkeypatch):
    monkeypatch.setitem(w.CFG, "HUB_ACCOUNT_ID", "999999999999")
    monkeypatch.setenv("AGENT_MONITOR_ROLE_ARN", "arn:aws:iam::999999999999:role/HubMonitor")
    client = FakeClient(result={"agentSpaceId": "as-h", "name": "hub"})
    _patch(monkeypatch, client)
    out = w.create_space("999999999999", "hub")
    assert out["primaryAccountConfigured"] is True
    assert client.assoc_calls[0]["configuration"]["aws"]["assumableRoleArn"] == (
        "arn:aws:iam::999999999999:role/HubMonitor"
    )


def test_missing_name_is_validation_error(monkeypatch):
    _patch(monkeypatch, FakeClient(result={}))
    out = w.create_space("111", "")
    assert out["ok"] is False and out["code"] == "validation"


def test_missing_account_is_validation_error(monkeypatch):
    _patch(monkeypatch, FakeClient(result={}))
    out = w.create_space("", "name")
    assert out["ok"] is False and out["code"] == "validation"


def test_overlong_name_is_validation_error(monkeypatch):
    _patch(monkeypatch, FakeClient(result={}))
    out = w.create_space("111", "x" * (w.NAME_MAX_LENGTH + 1))
    assert out["ok"] is False and out["code"] == "validation"


def test_access_denied_maps_to_create_denied(monkeypatch):
    _patch(monkeypatch, FakeClient(error_code="AccessDeniedException"))
    out = w.create_space("222", "n")
    assert out["ok"] is False and out["code"] == "create_denied"
    assert "ALLOW_AGENT_SPACE_CREATION" in out["error"]


def test_conflict_maps_to_conflict(monkeypatch):
    _patch(monkeypatch, FakeClient(error_code="ConflictException"))
    out = w.create_space("111", "dupe")
    assert out["ok"] is False and out["code"] == "conflict"


def test_other_client_error_maps_to_error(monkeypatch):
    _patch(monkeypatch, FakeClient(error_code="ThrottlingException"))
    out = w.create_space("111", "n")
    assert out["ok"] is False and out["code"] == "error"
    assert "ThrottlingException" in out["error"]


def test_handler_extracts_fields_tolerantly(monkeypatch):
    client = FakeClient(result={"agentSpaceId": "as-9", "name": "n"})
    _patch(monkeypatch, client)
    out = w.handler({"account": "111", "spaceName": "n", "Description": "d"})
    assert out["ok"] is True and out["agentSpaceId"] == "as-9"
    assert client.calls == [{"name": "n", "description": "d"}]
