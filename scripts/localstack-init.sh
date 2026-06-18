#!/usr/bin/env bash
# Provision SQS + SNS resources in LocalStack for Phase 2.
#
# Creates:
#   - agent-tasks-dlq        (dead-letter queue for poison pills)
#   - agent-tasks            (main queue) with a redrive policy: maxReceiveCount -> DLQ
#   - agent-events           (SNS topic) subscribed to the main queue (raw delivery,
#                             so MessageAttributes — incl. W3C traceparent — pass through)
#
# Idempotent: re-running is safe (create-* calls return existing ARNs/URLs).
set -euo pipefail

ENDPOINT="${AWS_ENDPOINT_URL:-http://localhost:4566}"
REGION="${AWS_REGION:-us-east-1}"
MAX_RECEIVE_COUNT="${SQS_MAX_RECEIVE_COUNT:-5}"
VISIBILITY_TIMEOUT="${SQS_VISIBILITY_TIMEOUT_SEC:-150}"

export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-test}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-test}"
export AWS_DEFAULT_REGION="$REGION"

aws() { command aws --endpoint-url "$ENDPOINT" "$@"; }

echo "==> Creating DLQ: agent-tasks-dlq"
DLQ_URL=$(aws sqs create-queue --queue-name agent-tasks-dlq --query QueueUrl --output text)
DLQ_ARN=$(aws sqs get-queue-attributes --queue-url "$DLQ_URL" \
  --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)
echo "    DLQ ARN: $DLQ_ARN"

echo "==> Creating main queue: agent-tasks (redrive maxReceiveCount=$MAX_RECEIVE_COUNT)"
# Build the RedrivePolicy as a JSON *string* (its value must itself be JSON-encoded).
REDRIVE_POLICY=$(printf '{\\"deadLetterTargetArn\\":\\"%s\\",\\"maxReceiveCount\\":\\"%s\\"}' "$DLQ_ARN" "$MAX_RECEIVE_COUNT")

# Create the queue plainly first (idempotent), then apply attributes below. Inline
# create-queue --attributes JSON escaping is fragile across aws-cli versions, so we
# write the attribute map to a temp file and pass it via file:// (version-independent).
QUEUE_URL=$(aws sqs create-queue --queue-name agent-tasks --query QueueUrl --output text)
QUEUE_ARN=$(aws sqs get-queue-attributes --queue-url "$QUEUE_URL" \
  --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)
echo "    Queue ARN: $QUEUE_ARN"

# Apply redrive policy + visibility timeout via set-queue-attributes.
# Note: visibility timeout MUST exceed max agent execution time (see env.schema.ts).
ATTRS_FILE=$(mktemp)
trap 'rm -f "$ATTRS_FILE"' EXIT
printf '{"VisibilityTimeout":"%s","RedrivePolicy":"%s"}' "$VISIBILITY_TIMEOUT" "$REDRIVE_POLICY" >"$ATTRS_FILE"
aws sqs set-queue-attributes --queue-url "$QUEUE_URL" --attributes "file://$ATTRS_FILE" >/dev/null
echo "    Redrive policy applied."

echo "==> Creating SNS topic: agent-events"
TOPIC_ARN=$(aws sns create-topic --name agent-events --query TopicArn --output text)
echo "    Topic ARN: $TOPIC_ARN"

echo "==> Subscribing agent-tasks to agent-events (raw message delivery)"
SUB_ARN=$(aws sns subscribe --topic-arn "$TOPIC_ARN" --protocol sqs \
  --notification-endpoint "$QUEUE_ARN" --return-subscription-arn --output text)
aws sns set-subscription-attributes --subscription-arn "$SUB_ARN" \
  --attribute-name RawMessageDelivery --attribute-value true
echo "    Subscription: $SUB_ARN (RawMessageDelivery=true)"

cat <<EOF

Provisioned. Suggested .env values:
  SQS_QUEUE_URL=$QUEUE_URL
  SQS_DLQ_URL=$DLQ_URL
  SNS_TOPIC_ARN=$TOPIC_ARN
EOF
