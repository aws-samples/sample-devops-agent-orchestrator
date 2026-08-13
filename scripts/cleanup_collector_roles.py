#!/usr/bin/env python3
"""
CLEANUP - the cross-account assumed role (DevOpsAgentCollectorRole).

Removes the read-only role from every account by deleting the service-managed
StackSet's stack instances + the StackSet itself, plus the standalone stack in
the management account.

Run with MANAGEMENT credentials (profile: default).
  python3 cleanup_collector_roles.py            # prompts for confirmation
  python3 cleanup_collector_roles.py --yes      # no prompt
"""
import time
from _common import CFG, mgmt_session, confirm

SESS = mgmt_session()
CFN = SESS.client("cloudformation")
SSNAME = CFG["STACKSET_NAME"]
MGMT_STACK = f"{SSNAME}-mgmt"


def org_root_id():
    return SESS.client("organizations").list_roots()["Roots"][0]["Id"]


def wait_op(op):
    while True:
        st = CFN.describe_stack_set_operation(
            StackSetName=SSNAME, OperationId=op
        )["StackSetOperation"]["Status"]
        print(f"  stackset op {op}: {st}")
        if st in ("SUCCEEDED", "FAILED", "STOPPED"):
            return
        time.sleep(15)


def delete_stackset():
    try:
        CFN.describe_stack_set(StackSetName=SSNAME)
    except CFN.exceptions.StackSetNotFoundException:
        print(f"  StackSet {SSNAME} not found")
        return
    root = org_root_id()
    print(f"  removing stack instances across org root {root} ...")
    try:
        op = CFN.delete_stack_instances(
            StackSetName=SSNAME,
            DeploymentTargets={"OrganizationalUnitIds": [root]},
            Regions=[CFG["REGION"]],
            RetainStacks=False,
        )["OperationId"]
        wait_op(op)
    except CFN.exceptions.StackInstanceNotFoundException:
        print("  no stack instances")
    except Exception as e:  # noqa: BLE001
        print(f"  delete_stack_instances: {e}")
    CFN.delete_stack_set(StackSetName=SSNAME)
    print(f"  deleted StackSet {SSNAME}")


def delete_mgmt_stack():
    try:
        CFN.delete_stack(StackName=MGMT_STACK)
        CFN.get_waiter("stack_delete_complete").wait(StackName=MGMT_STACK)
        print(f"  deleted management stack {MGMT_STACK}")
    except CFN.exceptions.ClientError as e:
        print(f"  management stack: {e}")


def main():
    print(f"This removes '{CFG['COLLECTOR_ROLE_NAME']}' from ALL org accounts.")
    print("After this, the hub can no longer collect from linked accounts.")
    if not confirm("Proceed with removing the cross-account collector role everywhere?"):
        print("Aborted.")
        return
    delete_stackset()
    delete_mgmt_stack()
    print("Collector role cleanup complete.")


if __name__ == "__main__":
    main()
