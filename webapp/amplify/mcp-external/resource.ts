import { Construct } from 'constructs';
import { CfnOutput, Stack } from 'aws-cdk-lib';
import { CfnGateway, CfnGatewayTarget } from 'aws-cdk-lib/aws-bedrockagentcore';
import { Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { CfnPermission, type IFunction } from 'aws-cdk-lib/aws-lambda';
import { EXTERNAL_TOOL_SCHEMAS } from '../functions/mcp-external/mcpExternalTools';

/**
 * EXTERNAL AgentCore Gateway — the MCP server external AI applications connect
 * to (Task 39, Requirement 16).
 *
 * A SECOND gateway alongside the internal `AWS_IAM` one (Task 29): inbound auth
 * is `CUSTOM_JWT` against the app's EXISTING Cognito user pool, so any EDO user
 * (Executive or Admin) signs in to their MCP client with their normal EDO
 * credentials (OAuth 2.0 Authorization Code + PKCE via the pool's Hosted UI).
 * Token validation (Requirement 16.10):
 *   - `discoveryUrl` — the pool's OIDC discovery document.
 *   - `allowedClients` — the DEDICATED external app client id. Cognito ACCESS
 *     tokens carry `client_id` (not `aud`), so client validation — not
 *     audience — pins tokens to the external client; SPA-issued tokens are
 *     rejected, and external access is revocable independently of web sign-in.
 *
 * The unauthenticated-request flow follows the MCP Protected Resource Metadata
 * pattern: the gateway answers 401 with a `www-authenticate` header pointing at
 * its `/.well-known/oauth-protected-resource`, which advertises the Cognito
 * authorization server — so OAuth-capable MCP clients (or `mcp-remote`)
 * discover the sign-in flow automatically.
 */
export interface ExternalMcpGatewayProps {
  /** The Lambda implementing the external MCP tools (the gateway target). */
  toolsLambda: IFunction;
  /** The Cognito user pool id (issuer of accepted JWTs). */
  userPoolId: string;
  /** The dedicated EXTERNAL app client id (the only accepted `client_id`). */
  externalClientId: string;
}

export class ExternalMcpGateway extends Construct {
  readonly gateway: CfnGateway;
  readonly gatewayUrl: string;

  constructor(scope: Construct, id: string, props: ExternalMcpGatewayProps) {
    super(scope, id);

    const { region } = Stack.of(this);

    // Role the gateway assumes to invoke the Lambda target (least-privilege:
    // InvokeFunction on just the external tools Lambda).
    const gatewayRole = new Role(this, 'GatewayRole', {
      assumedBy: new ServicePrincipal('bedrock-agentcore.amazonaws.com'),
      description: 'AgentCore Gateway role for invoking the EDO external MCP tools Lambda',
    });
    // grantInvoke adds the IAM identity policy on the gateway role (used for
    // the GATEWAY_IAM_ROLE credential provider) plus a role-scoped Lambda
    // resource policy.
    props.toolsLambda.grantInvoke(gatewayRole);

    // AgentCore Gateway names are ACCOUNT-scoped; suffix with the Amplify
    // branch so multiple environments in the hub account don't collide.
    const branch = process.env.AWS_BRANCH ?? 'sandbox';
    const envSuffix =
      branch.replace(/[^0-9a-zA-Z]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 56) || 'sandbox';

    this.gateway = new CfnGateway(this, 'Gateway', {
      name: `edo-mcp-external-${envSuffix}`,
      description: 'Enterprise DevOps Observatory — external AI application MCP access',
      protocolType: 'MCP',
      authorizerType: 'CUSTOM_JWT',
      authorizerConfiguration: {
        customJwtAuthorizer: {
          discoveryUrl: `https://cognito-idp.${region}.amazonaws.com/${props.userPoolId}/.well-known/openid-configuration`,
          allowedClients: [props.externalClientId],
        },
      },
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

    // Inline tool schema (single source of truth in mcpExternalTools.ts).
    // Deep-clone to strip the `as const` readonly/literal typing.
    const inlinePayload = JSON.parse(
      JSON.stringify(EXTERNAL_TOOL_SCHEMAS),
    ) as CfnGatewayTarget.ToolDefinitionProperty[];

    const target = new CfnGatewayTarget(this, 'ExternalTools', {
      gatewayIdentifier: this.gateway.attrGatewayIdentifier,
      name: 'edo-external-tools',
      description:
        'Read-only EDO tools for external AI apps: grounded Q&A, KB search, topology graph, business context, live agent-space chat',
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

    new CfnOutput(scope, 'ExternalMcpGatewayUrl', { value: this.gateway.attrGatewayUrl });
    new CfnOutput(scope, 'ExternalMcpGatewayId', { value: this.gateway.attrGatewayIdentifier });
  }
}
