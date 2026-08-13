"""Shared helpers: config loading and boto3 session/credential handling."""
import os
import sys
import boto3


def confirm(prompt, argv=None):
    """Destructive-action guard. Pass --yes to skip the interactive prompt."""
    if "--yes" in (argv if argv is not None else sys.argv):
        return True
    try:
        return input(f"{prompt} Type 'yes' to proceed: ").strip().lower() == "yes"
    except (EOFError, KeyboardInterrupt):
        return False

_HERE = os.path.dirname(os.path.abspath(__file__))
_CONFIG = os.path.join(os.path.dirname(_HERE), "config.env")

# Config keys the pipeline reads. In a Lambda (the scalable refresh fan-out,
# webapp task 26) there is no config.env on disk, so these are injected as
# environment variables by the backend and overlaid on top of the file. Local
# script runs set none of these env vars, so config.env continues to win there
# (backward compatible).
_ENV_KEYS = (
    "MGMT_ACCOUNT_ID", "MGMT_PROFILE", "HUB_ACCOUNT_ID", "HUB_PROFILE", "REGION",
    "COLLECTOR_ROLE_NAME", "EXTERNAL_ID", "HUB_BUCKET", "NEPTUNE_GRAPH_NAME",
    "NEPTUNE_LOAD_ROLE_NAME", "NEPTUNE_PUBLIC_CONNECTIVITY",
    "STACKSET_NAME", "ALLOW_AGENT_SPACE_CREATION",
    "KB_NAME", "KB_ROLE_NAME", "KB_EMBED_MODEL_ARN", "KB_CHAT_MODEL_ARN",
    "KB_DOCS_PREFIX",
)


def load_config(path=None):
    """Load pipeline config from config.env (if present) then overlay env vars.

    ``path`` defaults to ``CONFIG_ENV_PATH`` if set, else the repo-root
    config.env. A missing file is tolerated (returns an env-only config) so the
    same scripts run as Lambdas with configuration injected purely via the
    environment.
    """
    path = path or os.environ.get("CONFIG_ENV_PATH") or _CONFIG
    cfg = {}
    if os.path.exists(path):
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                cfg[k.strip()] = v.strip()
    # Environment variables override / supply config values (Lambda path).
    for key in _ENV_KEYS:
        val = os.environ.get(key)
        if val is not None and val != "":
            cfg[key] = val
    return cfg


CFG = load_config()


def _use_default_credentials():
    """True when the pipeline runs without named AWS profiles.

    Set PIPELINE_CREDENTIALS_MODE=default (the Fargate refresh task does this)
    to make sessions use the ambient credential chain - i.e. the ECS task role -
    instead of the local `~/.aws` profiles named in config.env. When unset,
    behaviour is unchanged (profile-based), so local script runs are unaffected.
    """
    return os.environ.get("PIPELINE_CREDENTIALS_MODE", "").lower() == "default"


def _default_chain_session():
    """A boto3 session backed by the ambient credential chain (task role)."""
    return boto3.Session(region_name=CFG["REGION"])


def _assume_role_session(role_arn, session_name):
    creds = _default_chain_session().client("sts").assume_role(
        RoleArn=role_arn, RoleSessionName=session_name,
    )["Credentials"]
    return boto3.Session(
        aws_access_key_id=creds["AccessKeyId"],
        aws_secret_access_key=creds["SecretAccessKey"],
        aws_session_token=creds["SessionToken"],
        region_name=CFG["REGION"],
    )


def mgmt_session():
    # In the Fargate refresh task there are no named profiles: use the task role,
    # optionally hopping into the management account for org listing via an
    # assumable role supplied in MGMT_ROLE_ARN.
    if _use_default_credentials():
        role_arn = os.environ.get("MGMT_ROLE_ARN")
        return (
            _assume_role_session(role_arn, "devops-agent-mgmt")
            if role_arn
            else _default_chain_session()
        )
    return boto3.Session(profile_name=CFG["MGMT_PROFILE"], region_name=CFG["REGION"])


def hub_session():
    if _use_default_credentials():
        return _default_chain_session()
    return boto3.Session(profile_name=CFG["HUB_PROFILE"], region_name=CFG["REGION"])


def list_org_accounts(active_only=True):
    """All accounts in the org (uses the management profile)."""
    org = mgmt_session().client("organizations")
    accounts = []
    for page in org.get_paginator("list_accounts").paginate():
        for a in page["Accounts"]:
            if active_only and a["Status"] != "ACTIVE":
                continue
            accounts.append({"id": a["Id"], "name": a["Name"], "email": a["Email"]})
    return accounts


def assume_collector(account_id):
    """
    Return a devops-agent-capable boto3 Session for a target account.

    - Hub account: use the hub profile directly (no hop needed).
    - Management account: use the management profile directly.
    - Everything else: the hub identity assumes DevOpsAgentCollectorRole.
    """
    if account_id == CFG["HUB_ACCOUNT_ID"]:
        return hub_session()
    if account_id == CFG["MGMT_ACCOUNT_ID"]:
        return mgmt_session()
    sts = hub_session().client("sts")
    role_arn = f"arn:aws:iam::{account_id}:role/{CFG['COLLECTOR_ROLE_NAME']}"
    creds = sts.assume_role(
        RoleArn=role_arn,
        RoleSessionName="devops-agent-collector",
        ExternalId=CFG["EXTERNAL_ID"],
    )["Credentials"]
    return boto3.Session(
        aws_access_key_id=creds["AccessKeyId"],
        aws_secret_access_key=creds["SecretAccessKey"],
        aws_session_token=creds["SessionToken"],
        region_name=CFG["REGION"],
    )
