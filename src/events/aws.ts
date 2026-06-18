import { SNSClient } from '@aws-sdk/client-sns';
import { SQSClient } from '@aws-sdk/client-sqs';
import type { AppConfigService } from '../config/app-config.service';

/**
 * AWS SDK v3 modular clients, pointed at LocalStack when AWS_ENDPOINT_URL is set
 * (the default for local dev — no real AWS account needed). Credentials are the
 * dummy LocalStack values from config.
 */
function clientConfig(config: AppConfigService) {
  return {
    region: config.awsRegion,
    endpoint: config.awsEndpointUrl || undefined,
    credentials: {
      accessKeyId: config.awsAccessKeyId,
      secretAccessKey: config.awsSecretAccessKey,
    },
  };
}

export const SNS_CLIENT = Symbol('SNS_CLIENT');
export const SQS_CLIENT = Symbol('SQS_CLIENT');

export function createSnsClient(config: AppConfigService): SNSClient {
  return new SNSClient(clientConfig(config));
}

export function createSqsClient(config: AppConfigService): SQSClient {
  return new SQSClient(clientConfig(config));
}
