import { fileURLToPath } from 'node:url';

import { Duration, Stack } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Effect, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import {
  Code,
  Function as LambdaFunction,
  LayerVersion,
  Runtime,
} from 'aws-cdk-lib/aws-lambda';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { RemovalPolicy } from 'aws-cdk-lib';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import {
  Choice,
  Condition,
  DefinitionBody,
  DistributedMap,
  Fail,
  JsonPath,
  Pass,
  ResultWriterV2,
  S3JsonItemReader,
  StateMachine,
  StateMachineType,
  Succeed,
  TaskInput,
  Wait,
  WaitTime,
} from 'aws-cdk-lib/aws-stepfunctions';
import { LambdaInvoke } from 'aws-cdk-lib/aws-stepfunctions-tasks';

export interface RefreshPipelineProps {
  /** Hub S3 bucket the pipeline reads/writes (manifest, shards, graph CSVs, KB docs). */
  readonly hubBucket: string;
  /** Region hosting the hub resources. */
  readonly hubRegion: string;
  /** Neptune Analytics graph name (never provisioned by refresh). @default from config.env */
  readonly neptuneGraphName?: string;
  /** IAM role name Neptune load creates/uses. @default DevOpsAgentNeptuneLoadRole */
  readonly neptuneLoadRoleName?: string;
  /** Bedrock managed KB name (never provisioned by refresh). @default devops-agent-kb */
  readonly kbName?: string;
  /** S3 prefix holding the KB docs. @default kb/ */
  readonly kbDocsPrefix?: string;
  /** Cross-account collector role assumed per member account. @default DevOpsAgentCollectorRole */
  readonly collectorRoleName?: string;
  /** ExternalId hardening the collector AssumeRole. */
  readonly externalId?: string;
  /** Hub account id (collected directly with the task role, no hop). */
  readonly hubAccountId?: string;
  /** Management account id (org listing / mgmt-account collection). */
  readonly mgmtAccountId?: string;
  /** Role ARN assumed to list Organizations accounts (+ collect the mgmt account). */
  readonly mgmtRoleArn?: string;
  /** Max accounts collected in parallel by the Distributed Map (throttle bound). @default 50 */
  readonly collectMaxConcurrency?: number;
}

/**
 * Scalable refresh orchestration (webapp task 26.3, Requirements 10.9–10.12).
 *
 * A Step Functions **Standard** state machine (runs up to 1 year — no ceiling on
 * a multi-hour refresh) that:
 *   1. ListAccounts  — write the active account list to S3 (`refresh/accounts.json`).
 *   2. CollectMap    — a **Distributed Map** (DISTRIBUTED mode) over that list,
 *                      `MaxConcurrency`-bounded, tolerated-failure, invoking the
 *                      Python CollectAccount worker per account (per-account
 *                      isolation — a bad account is recorded, not fatal).
 *   3. AssembleManifest — merge the per-account shards into `raw/_manifest.json`
 *                      (the only manifest write; Last_Sync_Date changes only here).
 *   4. Finalize      — Transform (graph CSVs + KB docs), then KbSync and
 *                      GraphReload as start + Wait/poll/Choice loops so the long
 *                      ingestion/import never runs inside a Lambda (no 15-min cap).
 *
 * All compute is Python Lambda (no Docker anywhere): the workers reuse the hub
 * `scripts/` as their single source of truth, with a locally/CI-built boto3
 * layer supplying the `devops-agent` client. `GET /refresh/status` reports the
 * collect Distributed Map's item counts as progress (Requirement 10.12).
 */
export class RefreshPipeline extends Construct {
  /** The refresh state machine (`POST /refresh` starts it; status describes it). */
  public readonly stateMachine: StateMachine;

  constructor(scope: Construct, id: string, props: RefreshPipelineProps) {
    super(scope, id);

    const { account, region } = Stack.of(this);
    const bucket = props.hubBucket;
    const bucketArn = `arn:aws:s3:::${bucket}`;
    const collectorRoleName = props.collectorRoleName ?? 'DevOpsAgentCollectorRole';
    const neptuneLoadRoleName = props.neptuneLoadRoleName ?? 'DevOpsAgentNeptuneLoadRole';
    const neptuneLoadRoleArn = `arn:aws:iam::${account}:role/${neptuneLoadRoleName}`;
    const maxConcurrency = props.collectMaxConcurrency ?? 50;

    // Code + layer assets. The Lambda code asset is the hub `scripts/` directory
    // (the workers import the collection/transform logic from it). The boto3
    // layer is built out-of-band (amplify.yml preBuild / a local build script,
    // see boto3-layer/README) so the runtime has a `devops-agent`-capable boto3
    // without any Docker bundling.
    const scriptsPath = fileURLToPath(new URL('../../../scripts', import.meta.url));
    const layerPath = fileURLToPath(new URL('./boto3-layer', import.meta.url));
    const boto3Layer = new LayerVersion(this, 'Boto3Layer', {
      code: Code.fromAsset(layerPath),
      compatibleRuntimes: [Runtime.PYTHON_3_12],
      description: 'Recent boto3/botocore providing the devops-agent client for the refresh workers.',
    });

    // Non-secret config env shared by every worker (mirrors config.env; _common
    // reads these env vars, so no config.env file is needed in the asset).
    const commonEnv: Record<string, string> = {
      PIPELINE_CREDENTIALS_MODE: 'default',
      HUB_BUCKET: bucket,
      REGION: props.hubRegion,
      ...(props.hubAccountId ? { HUB_ACCOUNT_ID: props.hubAccountId } : {}),
      ...(props.mgmtAccountId ? { MGMT_ACCOUNT_ID: props.mgmtAccountId } : {}),
      ...(props.mgmtRoleArn ? { MGMT_ROLE_ARN: props.mgmtRoleArn } : {}),
      COLLECTOR_ROLE_NAME: collectorRoleName,
      ...(props.externalId ? { EXTERNAL_ID: props.externalId } : {}),
      NEPTUNE_GRAPH_NAME: props.neptuneGraphName ?? 'devops-agent-topology',
      NEPTUNE_LOAD_ROLE_NAME: neptuneLoadRoleName,
      KB_NAME: props.kbName ?? 'devops-agent-kb',
      KB_DOCS_PREFIX: props.kbDocsPrefix ?? 'kb/',
    };

    const makeFn = (name: string, handler: string, timeout: Duration, memory = 512) => {
      const logGroup = new LogGroup(this, `${name}Logs`, {
        retention: RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      });
      return new LambdaFunction(this, name, {
        runtime: Runtime.PYTHON_3_12,
        code: Code.fromAsset(scriptsPath),
        handler,
        layers: [boto3Layer],
        environment: commonEnv,
        timeout,
        memorySize: memory,
        logGroup,
      });
    };

    // --- Worker Lambdas --------------------------------------------------------
    const listAccountsFn = makeFn('ListAccounts', 'list_accounts_worker.handler', Duration.minutes(5));
    const collectAccountFn = makeFn(
      'CollectAccount',
      'collect_account_worker.handler',
      Duration.minutes(15),
      1024,
    );
    const assembleFn = makeFn('AssembleManifest', 'assemble_manifest_worker.handler', Duration.minutes(15), 1024);
    const transformFn = makeFn('Transform', 'refresh_finalize_workers.transform', Duration.minutes(15), 2048);
    const startKbFn = makeFn('StartKbSync', 'refresh_finalize_workers.start_kb', Duration.minutes(2));
    const pollKbFn = makeFn('PollKbSync', 'refresh_finalize_workers.poll_kb', Duration.minutes(1));
    const startGraphFn = makeFn('StartGraphReload', 'refresh_finalize_workers.start_graph', Duration.minutes(5));
    const pollGraphFn = makeFn('PollGraphReload', 'refresh_finalize_workers.poll_graph', Duration.minutes(1));

    this.grantWorkerPermissions({
      bucketArn,
      region,
      account,
      collectorRoleName,
      neptuneLoadRoleArn,
      mgmtRoleArn: props.mgmtRoleArn,
      listAccountsFn,
      collectAccountFn,
      assembleFn,
      transformFn,
      startKbFn,
      pollKbFn,
      startGraphFn,
      pollGraphFn,
    });

    this.stateMachine = this.buildStateMachine({
      bucket,
      maxConcurrency,
      listAccountsFn,
      collectAccountFn,
      assembleFn,
      transformFn,
      startKbFn,
      pollKbFn,
      startGraphFn,
      pollGraphFn,
    });
  }

  /** Least-privilege policies per worker Lambda (scoped to the specific resources). */
  private grantWorkerPermissions(a: {
    bucketArn: string;
    region: string;
    account: string;
    collectorRoleName: string;
    neptuneLoadRoleArn: string;
    mgmtRoleArn?: string;
    listAccountsFn: LambdaFunction;
    collectAccountFn: LambdaFunction;
    assembleFn: LambdaFunction;
    transformFn: LambdaFunction;
    startKbFn: LambdaFunction;
    pollKbFn: LambdaFunction;
    startGraphFn: LambdaFunction;
    pollGraphFn: LambdaFunction;
  }): void {
    const s3ReadWrite = () =>
      new PolicyStatement({
        actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:ListBucket'],
        resources: [a.bucketArn, `${a.bucketArn}/*`],
      });
    const assumeMgmt = () =>
      a.mgmtRoleArn
        ? new PolicyStatement({ actions: ['sts:AssumeRole'], resources: [a.mgmtRoleArn] })
        : undefined;

    // ListAccounts: org listing (assume mgmt) + write accounts.json.
    a.listAccountsFn.addToRolePolicy(s3ReadWrite());
    const listAssume = assumeMgmt();
    if (listAssume) a.listAccountsFn.addToRolePolicy(listAssume);
    a.listAccountsFn.addToRolePolicy(
      new PolicyStatement({ actions: ['organizations:ListAccounts'], resources: ['*'] }),
    );

    // CollectAccount: assume the collector role in each member account (+ mgmt),
    // read DevOps Agent, write per-account shards.
    a.collectAccountFn.addToRolePolicy(s3ReadWrite());
    a.collectAccountFn.addToRolePolicy(
      new PolicyStatement({
        actions: ['sts:AssumeRole'],
        resources: [
          `arn:aws:iam::*:role/${a.collectorRoleName}`,
          ...(a.mgmtRoleArn ? [a.mgmtRoleArn] : []),
        ],
      }),
    );
    a.collectAccountFn.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        // AWS DevOps Agent's IAM action prefix is `aidevops` (the boto3 client
        // is named `devops-agent`, but the IAM namespace differs). This mirrors
        // the cross-account collector role (cloudformation/collector-role.yaml)
        // so hub/mgmt-account collection has the same read surface.
        actions: [
          'aidevops:List*',
          'aidevops:Get*',
          'aidevops:Describe*',
          'aidevops:ValidateAwsAssociations',
        ],
        resources: ['*'],
      }),
    );
    a.collectAccountFn.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        // Capability metrics (read-only) for hub/mgmt-account collection —
        // mirrors the CapabilityMetricsRead statement in the cross-account
        // collector role: log-delivery-endpoint counts (CloudWatch Logs vended
        // deliveries) and operator-app user counts (Identity Center assignments).
        actions: [
          'logs:DescribeDeliveries',
          'logs:DescribeDeliverySources',
          'sso:ListApplicationAssignments',
        ],
        resources: ['*'],
      }),
    );

    // AssembleManifest + Transform: S3 read/write only.
    a.assembleFn.addToRolePolicy(s3ReadWrite());
    a.transformFn.addToRolePolicy(s3ReadWrite());

    // KB sync (start + poll): discover + ingest on the managed KB.
    for (const fn of [a.startKbFn, a.pollKbFn]) {
      fn.addToRolePolicy(
        new PolicyStatement({ actions: ['bedrock:ListKnowledgeBases'], resources: ['*'] }),
      );
      fn.addToRolePolicy(
        new PolicyStatement({
          actions: [
            'bedrock:GetKnowledgeBase',
            'bedrock:ListDataSources',
            'bedrock:GetDataSource',
            'bedrock:StartIngestionJob',
            'bedrock:GetIngestionJob',
          ],
          resources: [`arn:aws:bedrock:${a.region}:${a.account}:knowledge-base/*`],
        }),
      );
    }

    // Graph reload (start + poll): Neptune reset + import on the existing graph,
    // and the load role the import task is passed.
    a.startGraphFn.addToRolePolicy(s3ReadWrite());
    for (const fn of [a.startGraphFn, a.pollGraphFn]) {
      fn.addToRolePolicy(new PolicyStatement({ actions: ['neptune-graph:ListGraphs'], resources: ['*'] }));
      fn.addToRolePolicy(
        new PolicyStatement({
          actions: [
            'neptune-graph:GetGraph',
            'neptune-graph:GetGraphSummary',
            'neptune-graph:ResetGraph',
            'neptune-graph:StartImportTask',
            'neptune-graph:GetImportTask',
          ],
          // StartImportTask / GetImportTask authorize on the import-task
          // resource, not the graph — grant both (Reset/Get* are on the graph).
          resources: [
            `arn:aws:neptune-graph:${a.region}:${a.account}:graph/*`,
            `arn:aws:neptune-graph:${a.region}:${a.account}:import-task/*`,
          ],
        }),
      );
    }
    a.startGraphFn.addToRolePolicy(
      new PolicyStatement({
        actions: ['iam:GetRole', 'iam:CreateRole', 'iam:PutRolePolicy'],
        resources: [a.neptuneLoadRoleArn],
      }),
    );
    a.startGraphFn.addToRolePolicy(
      new PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [a.neptuneLoadRoleArn],
        conditions: { StringEquals: { 'iam:PassedToService': 'neptune-graph.amazonaws.com' } },
      }),
    );
  }

  /** Build the ListAccounts → CollectMap → AssembleManifest → Finalize chain. */
  private buildStateMachine(a: {
    bucket: string;
    maxConcurrency: number;
    listAccountsFn: LambdaFunction;
    collectAccountFn: LambdaFunction;
    assembleFn: LambdaFunction;
    transformFn: LambdaFunction;
    startKbFn: LambdaFunction;
    pollKbFn: LambdaFunction;
    startGraphFn: LambdaFunction;
    pollGraphFn: LambdaFunction;
  }): StateMachine {
    const listAccounts = new LambdaInvoke(this, 'ListAccountsStep', {
      lambdaFunction: a.listAccountsFn,
      payloadResponseOnly: true,
      resultPath: JsonPath.DISCARD,
    });

    // Collect fan-out. The item source is the S3 accounts.json written by
    // ListAccounts; MaxConcurrency bounds the parallel collection to respect API
    // throttling; a high tolerated-failure keeps a partial run alive (per-account
    // failures are recorded in the shards, Requirement 10.10).
    const hubBucketRef = Bucket.fromBucketName(this, 'HubBucketForMap', a.bucket);
    const collectMap = new DistributedMap(this, 'CollectMap', {
      maxConcurrency: a.maxConcurrency,
      toleratedFailurePercentage: 100,
      itemReader: new S3JsonItemReader({ bucket: hubBucketRef, key: 'refresh/accounts.json' }),
      resultWriterV2: new ResultWriterV2({ bucket: hubBucketRef, prefix: 'refresh/results/' }),
      resultPath: JsonPath.DISCARD,
    });
    collectMap.itemProcessor(
      new LambdaInvoke(this, 'CollectAccountStep', {
        lambdaFunction: a.collectAccountFn,
        payloadResponseOnly: true,
      }),
    );

    const assemble = new LambdaInvoke(this, 'AssembleManifestStep', {
      lambdaFunction: a.assembleFn,
      payloadResponseOnly: true,
      resultPath: JsonPath.DISCARD,
    });

    const transform = new LambdaInvoke(this, 'TransformStep', {
      lambdaFunction: a.transformFn,
      payloadResponseOnly: true,
      resultPath: JsonPath.DISCARD,
    });

    // --- KB sync: start, then Wait/poll/Choice until COMPLETE/FAILED. ----------
    const startKb = new LambdaInvoke(this, 'StartKbSyncStep', {
      lambdaFunction: a.startKbFn,
      payloadResponseOnly: true,
      resultPath: '$.kb',
    });
    const waitKb = new Wait(this, 'WaitKbSync', { time: WaitTime.duration(Duration.seconds(20)) });
    const pollKb = new LambdaInvoke(this, 'PollKbSyncStep', {
      lambdaFunction: a.pollKbFn,
      payload: TaskInput.fromObject({
        kbId: JsonPath.stringAt('$.kb.kbId'),
        dataSourceId: JsonPath.stringAt('$.kb.dataSourceId'),
        ingestionJobId: JsonPath.stringAt('$.kb.ingestionJobId'),
      }),
      payloadResponseOnly: true,
      resultPath: '$.kbPoll',
    });
    const kbFailed = new Fail(this, 'KbSyncFailed', {
      error: 'KbSyncFailed',
      cause: 'The refresh failed during the kb_sync stage. The last sync date is unchanged.',
    });

    // --- Graph reload: start, then Wait/poll/Choice until terminal. ------------
    const startGraph = new LambdaInvoke(this, 'StartGraphReloadStep', {
      lambdaFunction: a.startGraphFn,
      payloadResponseOnly: true,
      resultPath: '$.graph',
    });
    const waitGraph = new Wait(this, 'WaitGraphReload', {
      time: WaitTime.duration(Duration.seconds(30)),
    });
    const pollGraph = new LambdaInvoke(this, 'PollGraphReloadStep', {
      lambdaFunction: a.pollGraphFn,
      payload: TaskInput.fromObject({ taskId: JsonPath.stringAt('$.graph.taskId') }),
      payloadResponseOnly: true,
      resultPath: '$.graphPoll',
    });
    const graphFailed = new Fail(this, 'GraphReloadFailed', {
      error: 'GraphReloadFailed',
      cause: 'The refresh failed during the graph_reload stage. The last sync date is unchanged.',
    });

    const succeeded = new Succeed(this, 'RefreshSucceeded');

    // Graph poll loop.
    const graphChoice = new Choice(this, 'GraphReloadDone?')
      .when(
        Condition.and(
          Condition.booleanEquals('$.graphPoll.done', true),
          Condition.booleanEquals('$.graphPoll.succeeded', true),
        ),
        succeeded,
      )
      .when(Condition.booleanEquals('$.graphPoll.done', true), graphFailed)
      .otherwise(waitGraph);
    startGraph.next(waitGraph);
    waitGraph.next(pollGraph);
    pollGraph.next(graphChoice);

    // KB poll loop -> graph reload.
    const kbChoice = new Choice(this, 'KbSyncDone?')
      .when(
        Condition.and(
          Condition.booleanEquals('$.kbPoll.done', true),
          Condition.booleanEquals('$.kbPoll.succeeded', true),
        ),
        startGraph,
      )
      .when(Condition.booleanEquals('$.kbPoll.done', true), kbFailed)
      .otherwise(waitKb);
    startKb.next(waitKb);
    waitKb.next(pollKb);
    pollKb.next(kbChoice);

    // Assemble a linear front then hand off to the finalize chain.
    transform.next(startKb);
    assemble.next(transform);
    collectMap.next(assemble);
    const definition = listAccounts.next(collectMap);
    // Keep an explicit no-op anchor so the chain reads top-down (optional).
    const start = new Pass(this, 'RefreshStart').next(definition);

    return new StateMachine(this, 'RefreshStateMachine', {
      definitionBody: DefinitionBody.fromChainable(start),
      stateMachineType: StateMachineType.STANDARD,
      timeout: Duration.hours(30),
    });
  }
}
