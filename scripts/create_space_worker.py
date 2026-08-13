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


def create_space(account_id, name, description=None):
    """
    Create one agent space in ``account_id`` and attach that account as the
    space's primary (monitor) account (the minimum useful configuration). Pure
    of the Lambda event shape so it is unit-testable. Returns a result dict:
      success : {"ok": True, "accountId", "agentSpaceId", "name",
                 "primaryAccountConfigured": bool, "warning"?: str}
      failure : {"ok": False, "code": <str>, "error": <str>}
    where ``code`` is one of: validation | create_denied | conflict | error.

    Primary-account association is best-effort: if it fails (e.g. the monitor
    role is missing in a linked account) the space is still created and a
    ``warning`` explains that the primary account was not configured.
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

    # Attach the hosting account as the primary (monitor) account. Best-effort:
    # the space already exists, so a failure here is a warning, not an error.
    role_arn = monitor_role_arn(account_id)
    if not role_arn:
        result["warning"] = (
            "The space was created but no monitor role is configured for the hub "
            "account (AGENT_MONITOR_ROLE_ARN is unset), so the primary account "
            "was not attached."
        )
        return result
    try:
        associate_primary_account(client, agent_space_id, account_id, role_arn)
        result["primaryAccountConfigured"] = True
    except ClientError as e:
        code = e.response["Error"]["Code"]
        msg = e.response["Error"]["Message"][:200]
        result["warning"] = (
            f"The space was created but the primary account could not be attached "
            f"({code}: {msg}). Ensure role {role_arn} exists in account {account_id} "
            "and trusts aidevops.amazonaws.com."
        )
    return result


def handler(event, _context=None):
    """Lambda entry point. Returns the {@link create_space} result dict."""
    account_id = _field(event, "accountId", "account", "id", "Account")
    name = _field(event, "name", "spaceName", "Name")
    description = _field(event, "description", "Description")
    return create_space(account_id, name, description)
