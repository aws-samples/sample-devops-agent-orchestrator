import { fileURLToPath } from 'node:url';

import { Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import {
  Effect,
  ManagedPolicy,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from 'aws-cdk-lib/aws-iam';
import { Code, Function as LambdaFunction, LayerVersion, Runtime } from 'aws-cdk-lib/aws-lambda';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

/**
 * Conventional monitor-role name used in LINKED/management accounts (created by
 * the collector-role StackSet). The worker builds a linked account's monitor
 * role ARN from this name. The HUB account's monitor role is created by this
 * construct with a CDK-GENERATED (unique) name — NOT this fixed name — because
 * multiple Amplify branch environments deploy into the same hub account and a
 * fixed role name collides across their CloudFormation stacks. The hub worker
 * uses the role's actual ARN (AGENT_MONITOR_ROLE_ARN), so the generated name is
 * fine.
 */
export const AGENT_MONITOR_ROLE_NAME = 'DevOpsAgentSpaceMonitorRole';

/**
 * Conventional operator-app role name used in LINKED/management accounts (the
 * role end users assume to reach a space's Operator Web App, "web operator
 * access"). Mirrors {@link AGENT_MONITOR_ROLE_NAME}: the HUB account's operator
 * role is created by this construct with a CDK-generated unique name (its ARN is
 * injected as AGENT_OPERATOR_ROLE_ARN), while linked accounts use this fixed
 * name (created by the collector-role StackSet when space creation is enabled).
 */
export const AGENT_OPERATOR_ROLE_NAME = 'DevOpsAgentOperatorAppRole';

export interface CreateSpaceWorkerProps {
  /** Region hosting the hub resources. */
  readonly hubRegion: string;
  /** Cross-account collector role assumed per member account. @default DevOpsAgentCollectorRole */
  readonly collectorRoleName?: string;
  /** ExternalId hardening the collector AssumeRole. */
  readonly externalId?: string;
  /** Hub account id (spaces created directly with the Lambda role, no hop). */
  readonly hubAccountId?: string;
  /** Management account id (spaces created via the management role). */
  readonly mgmtAccountId?: string;
  /** Role ARN assumed to reach the management account. */
  readonly mgmtRoleArn?: string;
}

/**
 * CreateAgentSpace worker (Admin-only `POST /spaces` compute).
 *
 * A Python Lambda that reuses the hub `scripts/` (`create_space_worker.handler`)
 * and the shared boto3 layer (the `devops-agent` client), invoked synchronously
 * by the Node `POST /spaces` route after it has authorized the Admin caller and
 * validated the request against the manifest. Kept as a Python worker for the
 * same reason as the refresh fan-out: the DevOps Agent API is only available in
 * the recent boto3 supplied by the layer, not the Node AWS SDK.
 *
 * Access model mirrors the collector (`_common.assume_collector`): the hub /
 * management account is reached with the Lambda's own role (or the mgmt role),
 * and linked accounts are reached by assuming `DevOpsAgentCollectorRole` there.
 * Creating a space in a linked account additionally requires that collector role
 * to allow `aidevops:CreateAgentSpace` (deployed with ALLOW_AGENT_SPACE_CREATION
 * =true); when it does not, the worker returns a `create_denied` result the
 * route surfaces as an actionable error.
 */
export class CreateSpaceWorker extends Construct {
  /** The worker Lambda the `POST /spaces` route invokes. */
  public readonly worker: LambdaFunction;

  /**
   * The role in the hub account the DevOps Agent service assumes to monitor it
   * (the primary-account association attached to new hub spaces).
   */
  public readonly monitorRole: Role;

  /**
   * The default IAM role backing "web operator access" — the Operator Web App
   * end users assume to reach a hub space (EnableOperatorApp, auth flow `iam`).
   */
  public readonly operatorRole: Role;

  constructor(scope: Construct, id: string, props: CreateSpaceWorkerProps) {
    super(scope, id);

    const { account, region } = Stack.of(this);
    const hubAccountId = props.hubAccountId ?? account;
    const collectorRoleName = props.collectorRoleName ?? 'DevOpsAgentCollectorRole';

    // ---------------------------------------------------------------------
    // Monitor role for the hub account's primary-account association.
    //
    // When a new agent space is created we attach the hosting account as the
    // space's PRIMARY (monitor) account via AssociateService (serviceId "aws",
    // configuration.aws accountType "monitor"), which requires an IAM role the
    // DevOps Agent service assumes to observe the account. This provisions that
    // role for the hub account with the same trust the console-created service
    // role uses: the `aidevops.amazonaws.com` service principal, scoped by
    // aws:SourceAccount to the hub account and aws:SourceArn to any agent space
    // in it. Permissions come from the AWS-managed AIDevOpsAgentAccessPolicy.
    // ---------------------------------------------------------------------
    this.monitorRole = new Role(this, 'AgentSpaceMonitorRole', {
      // No explicit roleName — a CDK-generated unique name avoids a cross-branch
      // collision in the shared hub account (the worker uses the role ARN).
      assumedBy: new ServicePrincipal('aidevops.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': hubAccountId },
          ArnLike: { 'aws:SourceArn': `arn:aws:aidevops:${region}:${hubAccountId}:agentspace/*` },
        },
      }),
      managedPolicies: [
        ManagedPolicy.fromManagedPolicyArn(
          this,
          'AIDevOpsAgentAccessPolicy',
          'arn:aws:iam::aws:policy/AIDevOpsAgentAccessPolicy',
        ),
      ],
      description:
        'Assumed by the AWS DevOps Agent service to monitor the hub account (primary-account association for spaces created from the app).',
    });

    // ---------------------------------------------------------------------
    // Operator-app role for "web operator access" (the Operator Web App).
    //
    // When a new agent space is created we optionally enable its Operator Web
    // App via EnableOperatorApp with auth flow `iam`, which requires an IAM role
    // end users assume to reach the app's AIDevOps APIs. This provisions that
    // default role for the hub account with the trust the CLI onboarding guide
    // prescribes: the `aidevops.amazonaws.com` service principal with BOTH
    // sts:AssumeRole and sts:TagSession (the operator app tags the session with
    // the AgentSpaceId), scoped by aws:SourceAccount + aws:SourceArn to any
    // agent space in the hub account. Permissions come from the AWS-managed
    // AIDevOpsOperatorAppAccessPolicy, which scopes access to the specific space
    // via the aws:PrincipalTag/AgentSpaceId condition.
    // ---------------------------------------------------------------------
    this.operatorRole = new Role(this, 'AgentSpaceOperatorRole', {
      // No explicit roleName — a CDK-generated unique name avoids a cross-branch
      // collision in the shared hub account (the worker uses the role ARN).
      assumedBy: new ServicePrincipal('aidevops.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': hubAccountId },
          ArnLike: { 'aws:SourceArn': `arn:aws:aidevops:${region}:${hubAccountId}:agentspace/*` },
        },
      }),
      managedPolicies: [
        ManagedPolicy.fromManagedPolicyArn(
          this,
          'AIDevOpsOperatorAppAccessPolicy',
          'arn:aws:iam::aws:policy/AIDevOpsOperatorAppAccessPolicy',
        ),
      ],
      description:
        'Assumed by AWS DevOps Agent Operator Web App users to access hub spaces (web operator access for spaces created from the app).',
    });
    // The operator-app trust additionally needs sts:TagSession (the service tags
    // the assumed session with the AgentSpaceId). ServicePrincipal only adds
    // sts:AssumeRole, so add the TagSession grant to the trust policy directly.
    this.operatorRole.assumeRolePolicy?.addStatements(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['sts:TagSession'],
        principals: [new ServicePrincipal('aidevops.amazonaws.com')],
        conditions: {
          StringEquals: { 'aws:SourceAccount': hubAccountId },
          ArnLike: { 'aws:SourceArn': `arn:aws:aidevops:${region}:${hubAccountId}:agentspace/*` },
        },
      }),
    );

    // Reuse the same code + layer assets as the refresh workers: the Lambda
    // code asset is the hub `scripts/` dir and the boto3 layer is the pip-built
    // `amplify/refresh/boto3-layer` (built out-of-band by amplify.yml preBuild).
    const scriptsPath = fileURLToPath(new URL('../../../scripts', import.meta.url));
    const layerPath = fileURLToPath(new URL('../refresh/boto3-layer', import.meta.url));
    const boto3Layer = new LayerVersion(this, 'Boto3Layer', {
      code: Code.fromAsset(layerPath),
      compatibleRuntimes: [Runtime.PYTHON_3_12],
      description: 'Recent boto3/botocore providing the devops-agent client for the create-space worker.',
    });

    const logGroup = new LogGroup(this, 'CreateAgentSpaceLogs', {
      retention: RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // _common reads config from env (no config.env in the asset). Only the keys
    // assume_collector needs are set — nothing about S3/KB/Neptune.
    const environment: Record<string, string> = {
      PIPELINE_CREDENTIALS_MODE: 'default',
      REGION: props.hubRegion,
      COLLECTOR_ROLE_NAME: collectorRoleName,
      HUB_ACCOUNT_ID: hubAccountId,
      // Primary-account association: the hub monitor role ARN + the conventional
      // role name used for other accounts (best-effort in linked accounts).
      AGENT_MONITOR_ROLE_ARN: this.monitorRole.roleArn,
      AGENT_MONITOR_ROLE_NAME: AGENT_MONITOR_ROLE_NAME,
      // "Web operator access": the hub operator-app role ARN + the conventional
      // role name used for other accounts (best-effort in linked accounts).
      AGENT_OPERATOR_ROLE_ARN: this.operatorRole.roleArn,
      AGENT_OPERATOR_ROLE_NAME: AGENT_OPERATOR_ROLE_NAME,
      ...(props.mgmtAccountId ? { MGMT_ACCOUNT_ID: props.mgmtAccountId } : {}),
      ...(props.mgmtRoleArn ? { MGMT_ROLE_ARN: props.mgmtRoleArn } : {}),
      ...(props.externalId ? { EXTERNAL_ID: props.externalId } : {}),
    };

    this.worker = new LambdaFunction(this, 'CreateAgentSpace', {
      runtime: Runtime.PYTHON_3_12,
      code: Code.fromAsset(scriptsPath),
      handler: 'create_space_worker.handler',
      layers: [boto3Layer],
      environment,
      timeout: Duration.minutes(2),
      memorySize: 512,
      logGroup,
    });

    // Assume the collector role in linked accounts (+ the mgmt role if given).
    this.worker.addToRolePolicy(
      new PolicyStatement({
        actions: ['sts:AssumeRole'],
        resources: [
          `arn:aws:iam::*:role/${collectorRoleName}`,
          ...(props.mgmtRoleArn ? [props.mgmtRoleArn] : []),
        ],
      }),
    );
    // Direct create for the hub/management account uses the Lambda's own role,
    // so it needs the DevOps Agent create action itself (IAM prefix `aidevops`).
    // CreateAgentSpace does not support resource-level permissions, so it is
    // authorized on `*`; the account is selected by the assumed session.
    this.worker.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          'aidevops:CreateAgentSpace',
          'aidevops:ListAgentSpaces',
          'aidevops:GetAgentSpace',
          // Attach the hosting account as the space's primary (monitor) account.
          'aidevops:AssociateService',
          // Enable "web operator access" (the Operator Web App) on new spaces.
          'aidevops:EnableOperatorApp',
          'aidevops:GetOperatorApp',
        ],
        resources: ['*'],
      }),
    );
    // Passing the monitor + operator-app roles to the DevOps Agent service (in
    // AssociateService / EnableOperatorApp) requires iam:PassRole on each,
    // constrained to the aidevops service.
    this.worker.addToRolePolicy(
      new PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [this.monitorRole.roleArn, this.operatorRole.roleArn],
        conditions: { StringEquals: { 'iam:PassedToService': 'aidevops.amazonaws.com' } },
      }),
    );
  }
}
