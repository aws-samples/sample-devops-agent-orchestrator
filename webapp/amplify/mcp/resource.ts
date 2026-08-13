import { Construct } from 'constructs';
import { CfnOutput, Stack } from 'aws-cdk-lib';
import { CfnGateway, CfnGatewayTarget } from 'aws-cdk-lib/aws-bedrockagentcore';
import { Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { CfnPermission, type IFunction } from 'aws-cdk-lib/aws-lambda';
import { TOOL_SCHEMAS } from '../functions/mcp-tools/mcpTools';

/**
 * AgentCore Gateway that exposes the EDO snapshot-plane tools as an MCP server
 * (Task 29, Requirement 15).
 *
 * The gateway aggregates a single Lambda target (the `mcp-tools` function) into
 * an MCP server. Inbound auth is AWS_IAM (SigV4) — the intended consumer is the
 * future org-wide agent on AgentCore Runtime (an AWS principal), so no public
 * JWT endpoint is exposed in this first slice; it can be switched to CUSTOM_JWT
 * (the existing Cognito pool) when the browser/agent needs token-based access.
 * The gateway assumes its own IAM role (GATEWAY_IAM_ROLE credential provider) to
 * invoke the tools Lambda, scoped to just that function.
 */
export interface McpGatewayProps {
  /** The Lambda implementing the MCP tools (the gateway target). */
  toolsLambda: IFunction;
}

export class McpGateway extends Construct {
  readonly gateway: CfnGateway;
  readonly gatewayUrl: string;

  constructor(scope: Construct, id: string, props: McpGatewayProps) {
    super(scope, id);

    // Role the gateway assumes to invoke the Lambda target (least-privilege:
    // InvokeFunction on just the tools Lambda).
    const gatewayRole = new Role(this, 'GatewayRole', {
      assumedBy: new ServicePrincipal('bedrock-agentcore.amazonaws.com'),
      description: 'AgentCore Gateway role for invoking the EDO MCP tools Lambda',
    });
    // grantInvoke adds the IAM identity policy on the gateway role (used for
    // the GATEWAY_IAM_ROLE credential provider) plus a role-scoped Lambda
    // resource policy.
    props.toolsLambda.grantInvoke(gatewayRole);

    // AgentCore Gateway names are ACCOUNT-scoped and must be unique. Multiple
    // Amplify environments (main + feature branches) deploy into the same hub
    // account, so the name is suffixed with the branch to avoid a 409 collision.
    // `AWS_BRANCH` is set by the Amplify build; default keeps local synth valid.
    const branch = process.env.AWS_BRANCH ?? 'sandbox';
    const envSuffix =
      branch.replace(/[^0-9a-zA-Z]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'sandbox';

    this.gateway = new CfnGateway(this, 'Gateway', {
      name: `edo-mcp-gateway-${envSuffix}`,
      description: 'Enterprise DevOps Observatory snapshot-plane MCP tools',
      protocolType: 'MCP',
      authorizerType: 'AWS_IAM',
      roleArn: gatewayRole.roleArn,
    });

    // AgentCore Gateway invokes the target Lambda using its SERVICE PRINCIPAL
    // (bedrock-agentcore.amazonaws.com), not the assumed gateway role — so the
    // role-scoped grant above is not sufficient and Lambda's default-deny
    // blocks the call. Add a resource-based policy statement for the service
    // principal, scoped by SourceArn to THIS gateway (and SourceAccount) so no
    // other gateway in the account can invoke the function. Created in the
    // gateway's stack (referencing the Lambda arn, which already flows this
    // way via the target) to avoid a lambda-stack -> gateway-stack cycle.
    new CfnPermission(this, 'AgentCoreInvoke', {
      functionName: props.toolsLambda.functionArn,
      action: 'lambda:InvokeFunction',
      principal: 'bedrock-agentcore.amazonaws.com',
      sourceArn: this.gateway.attrGatewayArn,
      sourceAccount: Stack.of(this).account,
    });

    // Inline tool schema (single source of truth in mcpTools.ts). Deep-clone to
    // strip the `as const` readonly/literal typing the L1 props do not accept.
    const inlinePayload = JSON.parse(JSON.stringify(TOOL_SCHEMAS)) as CfnGatewayTarget.ToolDefinitionProperty[];

    const target = new CfnGatewayTarget(this, 'SnapshotTools', {
      gatewayIdentifier: this.gateway.attrGatewayIdentifier,
      name: 'edo-snapshot-tools',
      description: 'Read-only EDO snapshot tools: KB search, topology graph, business context',
      targetConfiguration: {
        mcp: {
          lambda: {
            lambdaArn: props.toolsLambda.functionArn,
            toolSchema: { inlinePayload },
          },
        },
      },
      credentialProviderConfigurations: [{ credentialProviderType: 'GATEWAY_IAM_ROLE' }],
    });
    target.addDependency(this.gateway);

    this.gatewayUrl = this.gateway.attrGatewayUrl;

    new CfnOutput(scope, 'McpGatewayUrl', { value: this.gateway.attrGatewayUrl });
    new CfnOutput(scope, 'McpGatewayId', { value: this.gateway.attrGatewayIdentifier });
  }
}
