#!/usr/bin/env python3
"""
Step 1 - bootstrap the read-only collector role into every account.

Because the linked accounts joined the org by INVITATION they have no
OrganizationAccountAccessRole, so we cannot hop into them today. We use a
SERVICE-MANAGED CloudFormation StackSet (org trusted-access is already
enabled) to push the role into every member account, plus a standalone
stack for the management account (StackSets never target the mgmt account).

Run with the MANAGEMENT credentials (profile: default).

    python3 scripts/01_deploy_collector_roles.py            # deploy
    python3 scripts/01_deploy_collector_roles.py --status   # check only
"""
import sys
import time
from _common import CFG, mgmt_session

TEMPLATE = open(
    __file__.rsplit("/scripts/", 1)[0] + "/cloudformation/collector-role.yaml"
).read()

PARAMS = [
    {"ParameterKey": "HubAccountId", "ParameterValue": CFG["HUB_ACCOUNT_ID"]},
    {"ParameterKey": "CollectorRoleName", "ParameterValue": CFG["COLLECTOR_ROLE_NAME"]},
    {"ParameterKey": "ExternalId", "ParameterValue": CFG["EXTERNAL_ID"]},
    {"ParameterKey": "AllowAgentSpaceCreation",
     "ParameterValue": CFG.get("ALLOW_AGENT_SPACE_CREATION", "false")},
]
CAPS = ["CAPABILITY_NAMED_IAM"]


def org_root_id(sess):
    return sess.client("organizations").list_roots()["Roots"][0]["Id"]


def ensure_stackset(cfn):
    name = CFG["STACKSET_NAME"]
    try:
        cfn.describe_stack_set(StackSetName=name)
        print(f"StackSet {name} exists - updating template.")
        cfn.update_stack_set(
            StackSetName=name, TemplateBody=TEMPLATE, Parameters=PARAMS,
            Capabilities=CAPS, PermissionModel="SERVICE_MANAGED",
            AutoDeployment={"Enabled": True, "RetainStacksOnAccountRemoval": False},
        )
    except cfn.exceptions.StackSetNotFoundException:
        print(f"Creating service-managed StackSet {name}.")
        cfn.create_stack_set(
            StackSetName=name, TemplateBody=TEMPLATE, Parameters=PARAMS,
            Capabilities=CAPS, PermissionModel="SERVICE_MANAGED",
            AutoDeployment={"Enabled": True, "RetainStacksOnAccountRemoval": False},
        )


def deploy_instances(cfn, sess):
    root = org_root_id(sess)
    print(f"Creating stack instances across org root {root} in {CFG['REGION']} ...")
    op = cfn.create_stack_instances(
        StackSetName=CFG["STACKSET_NAME"],
        DeploymentTargets={"OrganizationalUnitIds": [root]},
        Regions=[CFG["REGION"]],
        OperationPreferences={"MaxConcurrentPercentage": 100, "FailureTolerancePercentage": 50},
    )["OperationId"]
    _wait(cfn, op)


def deploy_mgmt_stack(cfn):
    """Management account is excluded from service-managed StackSets."""
    name = f"{CFG['STACKSET_NAME']}-mgmt"
    print(f"Deploying standalone stack {name} in the management account ...")
    try:
        cfn.create_stack(StackName=name, TemplateBody=TEMPLATE, Parameters=PARAMS, Capabilities=CAPS)
        waiter = cfn.get_waiter("stack_create_complete")
    except cfn.exceptions.AlreadyExistsException:
        cfn.update_stack(StackName=name, TemplateBody=TEMPLATE, Parameters=PARAMS, Capabilities=CAPS)
        waiter = cfn.get_waiter("stack_update_complete")
    waiter.wait(StackName=name)
    print("  management account stack done.")


def _wait(cfn, op):
    while True:
        st = cfn.describe_stack_set_operation(
            StackSetName=CFG["STACKSET_NAME"], OperationId=op
        )["StackSetOperation"]["Status"]
        print(f"  StackSet operation {op}: {st}")
        if st in ("SUCCEEDED", "FAILED", "STOPPED"):
            return st
        time.sleep(15)


def status(cfn):
    name = CFG["STACKSET_NAME"]
    try:
        for page in cfn.get_paginator("list_stack_instances").paginate(StackSetName=name):
            for i in page["Summaries"]:
                print(f"  {i['Account']} / {i['Region']}: {i.get('StackInstanceStatus', {}).get('DetailedStatus', i['Status'])}")
    except cfn.exceptions.StackSetNotFoundException:
        print(f"StackSet {name} does not exist yet.")


def main():
    sess = mgmt_session()
    cfn = sess.client("cloudformation")
    if "--status" in sys.argv:
        status(cfn)
        return
    ensure_stackset(cfn)
    deploy_instances(cfn, sess)
    deploy_mgmt_stack(cfn)
    print("\nDone. Collector role present in all accounts. Verify with --status.")


if __name__ == "__main__":
    main()
