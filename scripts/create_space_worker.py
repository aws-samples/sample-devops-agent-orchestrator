#!/usr/bin/env python3
"""
CreateAgentSpace worker — the compute behind the Admin-only `POST /spaces` route
of the web app.

The Node route handler (authz + input validation + manifest existence check)
invokes this Lambda synchronously with an event of the shape:

    {"accountId": "<id>", "name": "<space name>", "description": "<optional>"}

Access model mirrors the collector (see `_common.assume_collector`):
  - hub / management account: uses the ambient task/Lambda role directly.
  - linked accounts        : assumes DevOpsAgentCollectorRole in the target
                             account. Creating a space there requires that role
                             to allow `aidevops:CreateAgentSpace` — i.e. the
                             collector role was deployed with
                             ALLOW_AGENT_SPACE_CREATION=true. Without it the
                             create is denied and reported (not raised).

The handler NEVER raises for an expected/operational failure: it returns a
compact, JSON-serialisable result with an `ok` flag and a `code` the caller maps
to an HTTP response, so a denied/conflicting create is a clean 4xx/5xx rather
than an opaque Lambda FunctionError.
"""
import os

from botocore.exceptions import ClientError

from _common import CFG, assume_collector

# The AWS account source is a service association with the literal serviceId
# "aws" (confirmed against a live agent space). `configuration.aws` with
# accountType "monitor" is the space's PRIMARY account — the account the agent
# observes. Without it a new space monitors nothing, so we attach the hosting
# account as the primary account as the minimum configuration.
SERVICE_ID_AWS = "aws"
# Convention for the per-account monitor role the DevOps Agent service assumes.
DEFAULT_MONITOR_ROLE_NAME = "DevOpsAgentSpaceMonitorRole"
# Convention for the per-account operator-app role end users assume to reach a
# space's Operator Web App ("web operator access"). Mirrors the monitor role.
DEFAULT_OPERATOR_ROLE_NAME = "DevOpsAgentOperatorAppRole"
# Auth flow for EnableOperatorApp. "iam" needs only the operator-app role (the
# "default IAM role for access"); "idc"/"idp" would need extra configuration.
OPERATOR_AUTH_FLOW = "iam"

# Keep in sync with shared-types AGENT_SPACE_* bounds (validated again here so a
# direct invoke — not only the Node route — can't create out-of-bounds names).
NAME_MIN_LENGTH = 1
NAME_MAX_LENGTH = 128
DESCRIPTION_MAX_LENGTH = 1024

# Cognito/DevOps-Agent error codes that mean "a space with that name already
# exists" — surfaced to the caller as a conflict rather than a generic error.
_CONFLICT_CODES = ("ConflictException", "ResourceAlreadyExistsException")
_DENIED_CODES = ("AccessDeniedException", "AccessDenied")


def _field(event, *keys):
    """First non-empty string value among ``keys`` in ``event`` (case tolerant)."""
    if not isinstance(event, dict):
        return None
    for key in keys:
        val = event.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
    return None


def _validate(account_id, name, description):
    """Return an error message if the inputs are invalid, else None."""
    if not account_id:
        return "An accountId is required."
    if not name:
        return "A space name is required."
    if not (NAME_MIN_LENGTH <= len(name) <= NAME_MAX_LENGTH):
        return f"The space name must be {NAME_MIN_LENGTH}-{NAME_MAX_LENGTH} characters."
    if description is not None and len(description) > DESCRIPTION_MAX_LENGTH:
        return f"The description must be at most {DESCRIPTION_MAX_LENGTH} characters."
    return None


def monitor_role_arn(account_id):
    """
    The IAM role the DevOps Agent service assumes to monitor ``account_id`` (the
    primary-account association). For the hub account the role is provisioned by
    the app (its ARN is injected as AGENT_MONITOR_ROLE_ARN); for other accounts
    a conventionally-named role in that account is used. Returns None only when
    the hub role env is unset for the hub account (mis-provisioned).
    """
    hub = CFG.get("HUB_ACCOUNT_ID")
    if hub and account_id == hub:
        arn = os.environ.get("AGENT_MONITOR_ROLE_ARN")
        return arn or None
    role_name = os.environ.get("AGENT_MONITOR_ROLE_NAME", DEFAULT_MONITOR_ROLE_NAME)
    return f"arn:aws:iam::{account_id}:role/{role_name}"


def operator_role_arn(account_id):
    """
    The IAM role end users assume to reach the space's Operator Web App ("web
    operator access"), passed to EnableOperatorApp. For the hub account the role
    is provisioned by the app (its ARN is injected as AGENT_OPERATOR_ROLE_ARN);
    for other accounts a conventionally-named role in that account is used.
    Returns None only when the hub role env is unset for the hub account.
    """
    hub = CFG.get("HUB_ACCOUNT_ID")
    if hub and account_id == hub:
        arn = os.environ.get("AGENT_OPERATOR_ROLE_ARN")
        return arn or None
    role_name = os.environ.get("AGENT_OPERATOR_ROLE_NAME", DEFAULT_OPERATOR_ROLE_NAME)
    return f"arn:aws:iam::{account_id}:role/{role_name}"


def enable_operator_app(client, agent_space_id, role_arn):
    """
    Enable the space's Operator Web App ("web operator access") with the IAM
    auth flow and the given default operator-app role. Returns the response dict
    on success; raises ClientError on failure so the caller can record a
    best-effort warning without failing the space creation.
    """
    return client.enable_operator_app(
        agentSpaceId=agent_space_id,
        authFlow=OPERATOR_AUTH_FLOW,
        operatorAppRoleArn=role_arn,
    )


def associate_primary_account(client, agent_space_id, account_id, role_arn):
    """
    Associate ``account_id`` as the space's PRIMARY (monitor) account. Returns
    the association dict on success; raises ClientError on failure so the caller
    can record a best-effort warning without failing the space creation.
    """
    return client.associate_service(
        agentSpaceId=agent_space_id,
        serviceId=SERVICE_ID_AWS,
        configuration={
            "aws": {
                "accountId": account_id,
                "accountType": "monitor",
                "assumableRoleArn": role_arn,
            }
        },
    )["association"]


def create_space(account_id, name, description=None, enable_web_operator=True):
    """
    Create one agent space in ``account_id``, attach that account as the space's
    primary (monitor) account, and (when ``enable_web_operator``) enable its
    Operator Web App ("web operator access") with a default IAM role. Pure of
    the Lambda event shape so it is unit-testable. Returns a result dict:
      success : {"ok": True, "accountId", "agentSpaceId", "name",
                 "primaryAccountConfigured": bool, "webOperatorEnabled"?: bool,
                 "warning"?: str}
      failure : {"ok": False, "code": <str>, "error": <str>}
    where ``code`` is one of: validation | create_denied | conflict | error.

    Both the primary-account association and the operator-app enablement are
    best-effort: if either fails (e.g. the required role is missing in a linked
    account) the space is still created and a ``warning`` explains what was not
    configured. Multiple warnings are joined into the single ``warning`` field.
    """
    invalid = _validate(account_id, name, description)
    if invalid:
        return {"ok": False, "code": "validation", "error": invalid}

    try:
        client = assume_collector(account_id).client("devops-agent")
    except ClientError as e:
        code = e.response["Error"]["Code"]
        msg = e.response["Error"]["Message"][:200]
        return {"ok": False, "code": "error",
                "error": f"Could not access account {account_id}: {code}: {msg}"}

    kwargs = {"name": name}
    if description:
        kwargs["description"] = description
    try:
        space = client.create_agent_space(**kwargs)["agentSpace"]
    except ClientError as e:
        code = e.response["Error"]["Code"]
        if code in _DENIED_CODES:
            return {"ok": False, "code": "create_denied",
                    "error": ("The collector role in account "
                              f"{account_id} does not permit creating agent spaces. "
                              "Redeploy the collector role with "
                              "ALLOW_AGENT_SPACE_CREATION=true.")}
        if code in _CONFLICT_CODES:
            return {"ok": False, "code": "conflict",
                    "error": f"An agent space named '{name}' already exists in account {account_id}."}
        return {"ok": False, "code": "error",
                "error": f"{code}: {e.response['Error']['Message'][:200]}"}

    agent_space_id = space["agentSpaceId"]
    result = {
        "ok": True,
        "accountId": account_id,
        "agentSpaceId": agent_space_id,
        "name": space.get("name", name),
        "primaryAccountConfigured": False,
    }

    warnings = []

    # Attach the hosting account as the primary (monitor) account. Best-effort:
    # the space already exists, so a failure here is a warning, not an error.
    role_arn = monitor_role_arn(account_id)
    if not role_arn:
        warnings.append(
            "no monitor role is configured for the hub account "
            "(AGENT_MONITOR_ROLE_ARN is unset), so the primary account was not attached"
        )
    else:
        try:
            associate_primary_account(client, agent_space_id, account_id, role_arn)
            result["primaryAccountConfigured"] = True
        except ClientError as e:
            code = e.response["Error"]["Code"]
            msg = e.response["Error"]["Message"][:200]
            warnings.append(
                f"the primary account could not be attached ({code}: {msg}); ensure role "
                f"{role_arn} exists in account {account_id} and trusts aidevops.amazonaws.com"
            )

    # Enable "web operator access" (the Operator Web App) with a default IAM
    # role. Best-effort and independent of the primary-account step above.
    if enable_web_operator:
        result["webOperatorEnabled"] = False
        op_role_arn = operator_role_arn(account_id)
        if not op_role_arn:
            warnings.append(
                "no operator-app role is configured for the hub account "
                "(AGENT_OPERATOR_ROLE_ARN is unset), so web operator access was not enabled"
            )
        else:
            try:
                enable_operator_app(client, agent_space_id, op_role_arn)
                result["webOperatorEnabled"] = True
            except ClientError as e:
                code = e.response["Error"]["Code"]
                msg = e.response["Error"]["Message"][:200]
                warnings.append(
                    f"web operator access could not be enabled ({code}: {msg}); ensure role "
                    f"{op_role_arn} exists in account {account_id} and trusts aidevops.amazonaws.com"
                )

    if warnings:
        result["warning"] = "The space was created but " + "; ".join(warnings) + "."
    return result


def handler(event, _context=None):
    """Lambda entry point. Returns the {@link create_space} result dict."""
    account_id = _field(event, "accountId", "account", "id", "Account")
    name = _field(event, "name", "spaceName", "Name")
    description = _field(event, "description", "Description")
    # Web operator access defaults ON; the Node route sends an explicit boolean.
    enable_web_operator = event.get("webOperator", True) if isinstance(event, dict) else True
    return create_space(account_id, name, description, enable_web_operator=bool(enable_web_operator))
