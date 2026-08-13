import {
  HttpIntegrationType,
  HttpRouteIntegration,
  type HttpRouteIntegrationBindOptions,
  type HttpRouteIntegrationConfig,
  PayloadFormatVersion,
} from 'aws-cdk-lib/aws-apigatewayv2';
import { CfnPermission, type IFunction } from 'aws-cdk-lib/aws-lambda';
import { Stack } from 'aws-cdk-lib';

/**
 * AWS_PROXY (Lambda proxy) integration for an HTTP API route (Task 3).
 *
 * A dependency-free equivalent of the alpha `HttpLambdaIntegration`: it wires a
 * route to a Lambda handler using payload format 2.0 and grants API Gateway
 * permission to invoke the target function, scoped to THIS specific HTTP API
 * (least-privilege invoke grant).
 */
export class LambdaProxyIntegration extends HttpRouteIntegration {
  constructor(
    private readonly integrationId: string,
    private readonly handler: IFunction,
  ) {
    super(integrationId);
  }

  bind(options: HttpRouteIntegrationBindOptions): HttpRouteIntegrationConfig {
    const route = options.route;
    const stack = Stack.of(route);
    // Grant API Gateway permission to invoke this handler, scoped to THIS
    // specific HTTP API's execute-api ARN — not a wildcard that would let any
    // API in the account invoke the function.
    //
    // The permission is created in the API stack (where the HttpApi lives) so
    // the reference to the API id stays intra-stack. Creating it here rather
    // than via `handler.addPermission` (which would place it in the FUNCTION
    // stack and make that stack reference the API id) is what avoids a
    // function->api dependency cycling with the api->function integration
    // reference. The construct id is keyed off the unique per-route integration
    // id so a handler shared by multiple routes (e.g. GET + PUT /context) does
    // not collide.
    new CfnPermission(stack, `InvokeApi-${this.integrationId}`, {
      action: 'lambda:InvokeFunction',
      functionName: this.handler.functionArn,
      principal: 'apigateway.amazonaws.com',
      // Defaults to this API's ARN with wildcard stage/method/path.
      sourceArn: route.httpApi.arnForExecuteApi(),
    });
    return {
      type: HttpIntegrationType.AWS_PROXY,
      uri: this.handler.functionArn,
      payloadFormatVersion: PayloadFormatVersion.VERSION_2_0,
    };
  }
}
