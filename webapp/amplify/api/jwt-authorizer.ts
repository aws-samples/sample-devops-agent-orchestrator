import {
  HttpAuthorizer,
  HttpAuthorizerType,
  type HttpRouteAuthorizerBindOptions,
  type HttpRouteAuthorizerConfig,
  type IHttpRouteAuthorizer,
} from 'aws-cdk-lib/aws-apigatewayv2';

/** Configuration for {@link CognitoJwtAuthorizer}. */
export interface CognitoJwtAuthorizerProps {
  /** Cognito user pool id (issuer). */
  readonly userPoolId: string;
  /** App client id(s) accepted as the JWT audience. */
  readonly userPoolClientIds: string[];
  /** AWS region of the user pool. */
  readonly region: string;
  /**
   * Request locations checked for the token.
   * @default ['$request.header.Authorization']
   */
  readonly identitySource?: string[];
  /** @default 'DevOpsObservatoryCognitoJwtAuthorizer' */
  readonly authorizerName?: string;
}

/**
 * HTTP API JWT authorizer bound to the DevOps Observatory Cognito user pool
 * (Task 3, Requirements 1.2, 2.6).
 *
 * API Gateway validates the Cognito access token against the pool's issuer and
 * the app client audience on EVERY route this authorizer is attached to, so
 * unauthenticated requests are rejected before any Lambda handler runs. The
 * verified `cognito:groups` claim then flows through to handlers for the
 * Admin-group assertion (see `functions/shared/authz.ts`).
 *
 * This is a thin, dependency-free wrapper over the stable `HttpAuthorizer` L2
 * construct (equivalent to the alpha `HttpJwtAuthorizer`); it lazily creates a
 * single underlying authorizer the first time it is bound to a route and reuses
 * it for every subsequent route.
 */
export class CognitoJwtAuthorizer implements IHttpRouteAuthorizer {
  private authorizer?: HttpAuthorizer;

  constructor(
    private readonly id: string,
    private readonly props: CognitoJwtAuthorizerProps,
  ) {}

  bind(options: HttpRouteAuthorizerBindOptions): HttpRouteAuthorizerConfig {
    if (!this.authorizer) {
      const { region, userPoolId, userPoolClientIds } = this.props;
      this.authorizer = new HttpAuthorizer(options.scope, this.id, {
        httpApi: options.route.httpApi,
        type: HttpAuthorizerType.JWT,
        authorizerName: this.props.authorizerName ?? 'DevOpsObservatoryCognitoJwtAuthorizer',
        identitySource: this.props.identitySource ?? ['$request.header.Authorization'],
        jwtIssuer: `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`,
        jwtAudience: userPoolClientIds,
      });
    }
    return {
      authorizerId: this.authorizer.authorizerId,
      authorizationType: 'JWT',
    };
  }
}
