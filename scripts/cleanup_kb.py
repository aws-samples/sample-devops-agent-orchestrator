#!/usr/bin/env python3
"""
CLEANUP - Bedrock managed knowledge base. Deletes the data source(s), the KB
(which tears down the Bedrock-managed vector store), and the KB service role.
Does NOT delete the S3 docs (cheap, and the source of truth).

Run with hub credentials (profile 123456789012).
  python3 cleanup_kb.py            # prompts for confirmation
  python3 cleanup_kb.py --yes      # no prompt
"""
import time
from botocore.exceptions import ClientError
from _common import CFG, hub_session, confirm

SESS = hub_session()
BA = SESS.client("bedrock-agent")
IAM = SESS.client("iam")
NAME = CFG["KB_NAME"]


def kb_id():
    for p in BA.get_paginator("list_knowledge_bases").paginate():
        for kb in p["knowledgeBaseSummaries"]:
            if kb["name"] == NAME:
                return kb["knowledgeBaseId"]
    return None


def delete_role():
    role = CFG["KB_ROLE_NAME"]
    try:
        for p in IAM.list_role_policies(RoleName=role)["PolicyNames"]:
            IAM.delete_role_policy(RoleName=role, PolicyName=p)
        IAM.delete_role(RoleName=role)
        print(f"  deleted role {role}")
    except IAM.exceptions.NoSuchEntityException:
        print(f"  role {role} already gone")


def main():
    kid = kb_id()
    if kid:
        print(f"Knowledge base {NAME} = {kid}")
    else:
        print(f"No knowledge base named {NAME}. Checking for leftover role ...")
    if not confirm(f"Delete knowledge base '{NAME}', its data sources, and the KB role?"):
        print("Aborted.")
        return
    if kid:
        for p in BA.get_paginator("list_data_sources").paginate(knowledgeBaseId=kid):
            for ds in p["dataSourceSummaries"]:
                BA.delete_data_source(knowledgeBaseId=kid, dataSourceId=ds["dataSourceId"])
                print(f"  deleted data source {ds['dataSourceId']}")
        for _ in range(30):
            try:
                BA.delete_knowledge_base(knowledgeBaseId=kid)
                print(f"  deleting KB {kid} ...")
                break
            except ClientError as e:
                if "Conflict" in str(e) or "in use" in str(e).lower():
                    time.sleep(5)
                else:
                    raise
    delete_role()
    print("KB cleanup complete. (S3 docs under kb/ were left in place.)")


if __name__ == "__main__":
    main()
