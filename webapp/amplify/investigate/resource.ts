import { fileURLToPath } from 'node:url';

import { Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import { ManagedPolicy, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Alias, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

/**
 * Durable `investigate` function (Task 38) — the async, human-in-the-loop
 * DevOps Agent investigation orchestrator.
 *
 * This is a Lambda DURABLE FUNCTION, which the Amplify `defineFunction` path
 * cannot express (durable execution must be enabled at CREATE time via
 * `durableConfig`, needs a Node 22/24 runtime, and must be invoked by a
 * QUALIFIED ARN). So it is a raw CDK construct — like the refresh / create-space
 * workers — bundled with `NodejsFunction` (esbuild, no Docker) so the durable
 * SDK is packaged with the handler. A `live` alias provides the qualified ARN
 * the API lambda invokes.
 *
 * Least-privilege: read the space's Bearer token from Secrets Manager (the same
 * `devops-observatory/a2a/*` secrets the API lambda manages) and read/write the
 * per-execution index objects under `hub/a2a_investigations/*` in the hub bucket
 * (the S3 side-channel the API lambda polls). Durable checkpoint permissions are
 * granted via the AWS-managed durable-execution role policy.
 */
export interface InvestigateDurableFunctionProps {
  /** Hub bucket holding the per-execution index objects (S3 side-channel). */
  readonly hubBucket: string;
  /** Region hosting the hub resources (secrets + bucket + A2A remote server). */
  readonly hubRegion: string;
}

export class InvestigateDurableFunction extends Construct {
  /** The durable Lambda function (used for GetDurableExecution / callback grants). */
  public readonly fn: NodejsFunction;
  /** The `live` alias — the QUALIFIED ARN the API lambda must invoke. */
  public readonly alias: Alias;
  /** Convenience: the qualified alias ARN (for the API lambda's env). */
  public readonly qualifiedArn: string;

  constructor(scope: Construct, id: string, props: InvestigateDurableFunctionProps) {
    super(scope, id);

    const { account, region } = Stack.of(this);
    const entry = fileURLToPath(new URL('../functions/a2a-investigate/handler.ts', import.meta.url));

    const logGroup = new LogGroup(this, 'InvestigateLogs', {
      retention: RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.fn = new NodejsFunction(this, 'Investigate', {
      entry,
      handler: 'handler',
      runtime: Runtime.NODEJS_24_X,
      // Durable execution: up to 24h total wall-clock (poll window ~2h + the 12h
      // human-approval window + margin); keep execution history for 7 days.
      durableConfig: {
        executionTimeout: Duration.hours(24),
        retentionPeriod: Duration.days(7),
      },
      // Per-invocation compute budget: the longest single burst is the initial
      // `message:send` (up to 120s) — waits between polls do not consume this.
      timeout: Duration.seconds(130),
      memorySize: 512,
      logGroup,
      environment: {
        HUB_BUCKET: props.hubBucket,
        HUB_REGION: props.hubRegion,
      },
      bundling: {
        format: OutputFormat.CJS,
        // Keep the AWS SDK v3 external (present in the Node 24 runtime); bundle
        // everything else, notably the durable-execution SDK + shared types.
        externalModules: ['@aws-sdk/*'],
      },
    });

    // Durable checkpoint / state permissions (required with an explicit log group).
    this.fn.role?.addManagedPolicy(
      ManagedPolicy.fromAwsManagedPolicyName(
        'service-role/AWSLambdaBasicDurableExecutionRolePolicy',
      ),
    );

    // Read the per-space Bearer token (same secrets the API lambda manages).
    this.fn.addToRolePolicy(
      new PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [`arn:aws:secretsmanager:${region}:${account}:secret:devops-observatory/a2a/*`],
      }),
    );
    // Read/write the per-execution index objects (S3 side-channel).
    this.fn.addToRolePolicy(
      new PolicyStatement({
        actions: ['s3:GetObject', 's3:PutObject'],
        resources: [`arn:aws:s3:::${props.hubBucket}/hub/a2a_investigations/*`],
      }),
    );

    // A `live` alias gives the qualified ARN durable invocation requires.
    this.alias = new Alias(this, 'Live', {
      aliasName: 'live',
      version: this.fn.currentVersion,
    });
    this.qualifiedArn = this.alias.functionArn;
  }
}
