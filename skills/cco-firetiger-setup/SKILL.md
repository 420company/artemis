---
description: Set up Firetiger monitoring for this project - detects your stack, adds OpenTelemetry instrumentation, and creates a monitoring agent
user-invocable: true
---

# Firetiger Setup

You are setting up Firetiger observability for this project. Your goal is **minimal user interaction** - automatically detect the stack, instrument the code, connect integrations, and create a monitoring agent.

## Step 1: Authenticate

First, check if Firetiger MCP tools are available by trying to call `get_ingest_credentials`.

If the tools are NOT available (you get an error about tools not being loaded, or the tool doesn't exist), tell the user:

```
Firetiger needs authentication. Please:

1. Type /mcp and press Enter
2. Select plugin:firetiger:firetiger
3. Sign in or create an account in the browser window
```

When the user is done, retry calling `get_ingest_credentials` and proceed with setup.

If the tools ARE available, the `get_ingest_credentials` call also handles Step 2 (provisioning), so proceed to Step 3.

## Step 2: Provision

If you didn't already get credentials in Step 1, call `get_ingest_credentials` to provision the organization's backend (credentials, data storage). This auto-provisions if not already set up.

## Step 3: Detect the Stack

Explore the codebase to identify telemetry sources and services Firetiger can connect to:

### Deployment Platforms (Log Forwarding)
- **Vercel**: `vercel.json`, `.vercel/` - set up Log Drain
- **Cloudflare**: `wrangler.toml` - set up Logpush
- **AWS**: CloudFormation/CDK/Terraform - CloudWatch, ALB, CloudFront, EventBridge logs
- **GCP**: GCP configs - Cloud Logging

### Telemetry Sources
- **OpenTelemetry**: `@opentelemetry/*`, `opentelemetry-*` Python, `go.opentelemetry.io`
- **Datadog**: `dd-trace`, `datadog` packages
- **Prometheus**: `prometheus.yml`, Grafana configs - PromQL queries or remote write
- **Vector**: `vector.toml` - forward logs/traces/metrics

### Databases (direct query)
- **PostgreSQL**: Prisma, SQLAlchemy, connection strings
- **MySQL**: Prisma, connection strings
- **ClickHouse**: clickhouse-client configs

### Event & Incident Sources
- **GitHub**: `.git/config` - webhook events
- **SendGrid**: SendGrid API keys - email events
- **Kafka**: Kafka configs - topic ingestion
- **Incident.io**: incident.io integration
- **PagerDuty**: PagerDuty API keys

### Language & Framework (for OTEL auto-instrumentation)
- `package.json` -> Node.js (Next.js, Express, etc.)
- `requirements.txt` / `pyproject.toml` -> Python
- `go.mod` -> Go

## Step 4: Connect Integrations

### Proactively connect (detected in Step 3)
Automatically initiate connections for integrations detected in the codebase. User can decline.
- **GitHub**: If `.git` remote points to github.com
- **PostgreSQL/MySQL/ClickHouse**: If database configs found
- **AWS/GCP**: If cloud configs found
- **Datadog/Prometheus**: If telemetry configs found
- **Vercel/Cloudflare**: If deployment configs found

### Ask about others
Ask one question: "Which of these do you use? (select all that apply): Slack, Linear, PagerDuty, Incident.io"

Then connect the ones they selected.

Use `create` MCP tool or `onboard_*` tools. OAuth connections open a browser window.

### Warn About Missing Connections

After attempting connections, if none were configured, warn the user:

> "No integrations connected. Your agent will be able to monitor and analyze your application, but won't be able to take actions like sending Slack alerts or creating GitHub issues. You can add connections later from the Firetiger dashboard."

If only some connections were skipped, note what capabilities are missing:
- No Slack: "Agent won't be able to send real-time alerts"
- No GitHub: "Agent won't be able to search codebase or keep track of deployments"

## Step 5: Set Up Telemetry

Call `get_ingest_credentials` to get the ingest endpoint, username, and password.

Based on the deployment platform detected in Step 3, set up telemetry automatically using CLI tools.

### Vercel
Check if Vercel CLI is available: `which vercel`

If available, use the Vercel API to create log drains:
1. Ask user for a Vercel token (or check if `vercel whoami` works)
2. Get project list and team ID:
```bash
curl -H "Authorization: Bearer $TOKEN" "https://api.vercel.com/v9/projects"
```
3. Create log drain:
```bash
curl -X POST "https://api.vercel.com/v1/drains" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Send logs to Firetiger",
    "projects": "some",
    "projectIds": ["'$PROJECT_ID'"],
    "schemas": {"log": {"version": "v1"}},
    "delivery": {
      "type": "http",
      "endpoint": "'$INGEST_URL'/vercel/logs",
      "encoding": "json",
      "headers": {"Authorization": "Basic '$AUTH_HEADER'"}
    },
    "filter": {
      "version": "v2",
      "filter": {
        "type": "basic",
        "log": {"sources": ["lambda", "edge"]},
        "deployment": {"environments": ["production"]}
      }
    }
  }'
```
4. Create traces drain:
```bash
curl -X POST "https://api.vercel.com/v1/drains" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Send traces to Firetiger",
    "projects": "some",
    "projectIds": ["'$PROJECT_ID'"],
    "schemas": {"trace": {"version": "v1"}},
    "delivery": {
      "type": "otlphttp",
      "endpoint": {"traces": "'$INGEST_URL'/v1/traces"},
      "encoding": "json",
      "headers": {"Authorization": "Basic '$AUTH_HEADER'"}
    }
  }'
```

### AWS CloudWatch
Check if AWS CLI is available: `which aws`

If available, deploy CloudFormation stack:
```bash
aws cloudformation create-stack \
  --stack-name firetiger-cloudwatch-logs \
  --template-url https://firetiger-public-$REGION.s3.$REGION.amazonaws.com/ingest/aws/cloudwatch/logs/ingest-and-iam-onboarding.yaml \
  --parameters \
    ParameterKey=FiretigerEndpoint,ParameterValue=$INGEST_URL \
    ParameterKey=FiretigerUsername,ParameterValue=$USERNAME \
    ParameterKey=FiretigerPassword,ParameterValue=$PASSWORD \
    ParameterKey=FiretigerExternalId,ParameterValue=$(uuidgen) \
  --capabilities CAPABILITY_NAMED_IAM \
  --region $REGION
```

Wait for stack creation, then get the Role ARN from outputs:
```bash
aws cloudformation describe-stacks --stack-name firetiger-cloudwatch-logs --query 'Stacks[0].Outputs'
```

### GCP Cloud Logging
Check if gcloud CLI is available: `which gcloud`

If available, run the setup commands:
```bash
# Get current project
PROJECT=$(gcloud config get-value project)

# Enable required APIs
gcloud services enable cloudfunctions.googleapis.com pubsub.googleapis.com logging.googleapis.com run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com eventarc.googleapis.com

# Create Pub/Sub topic
gcloud pubsub topics create firetiger-cloud-logs

# Create logging sink
gcloud logging sinks create firetiger-cloud-logs pubsub.googleapis.com/projects/$PROJECT/topics/firetiger-cloud-logs

# Grant sink publish permission
SINK_SA=$(gcloud logging sinks describe firetiger-cloud-logs --format='value(writerIdentity)')
gcloud pubsub topics add-iam-policy-binding firetiger-cloud-logs --member="$SINK_SA" --role="roles/pubsub.publisher"

# Deploy Cloud Function
gcloud functions deploy firetiger-cloud-logs-forwarder \
  --gen2 \
  --runtime=python313 \
  --trigger-topic=firetiger-cloud-logs \
  --entry-point=process_log_entry \
  --set-env-vars="FT_EXPORTER_ENDPOINT=$INGEST_URL,FT_EXPORTER_BASIC_AUTH_USERNAME=$USERNAME,FT_EXPORTER_BASIC_AUTH_PASSWORD=$PASSWORD" \
  --source=gs://firetiger-public/ingest/gcp/cloud-logging/function.zip \
  --region=$REGION
```

### Cloudflare Workers
Check if wrangler CLI is available: `which wrangler`

If available:
1. Get account ID and API credentials: `wrangler whoami` or ask user for Cloudflare API key/email
2. Create observability destinations via Cloudflare API:
```bash
# Create traces destination
curl -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/observability/destinations" \
  -H "X-Auth-Email: $CF_EMAIL" \
  -H "X-Auth-Key: $CF_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "firetiger-traces",
    "enabled": true,
    "configuration": {
      "type": "logpush",
      "logpushDataset": "opentelemetry-traces",
      "url": "'$INGEST_URL'/v1/traces",
      "headers": {"Authorization": "Basic '$AUTH_HEADER'"}
    }
  }'

# Create logs destination
curl -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/observability/destinations" \
  -H "X-Auth-Email: $CF_EMAIL" \
  -H "X-Auth-Key: $CF_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "firetiger-logs",
    "enabled": true,
    "configuration": {
      "type": "logpush",
      "logpushDataset": "opentelemetry-logs",
      "url": "'$INGEST_URL'/v1/logs",
      "headers": {"Authorization": "Basic '$AUTH_HEADER'"}
    }
  }'
```

3. Update `wrangler.toml` to enable observability:
```toml
[observability.traces]
enabled = true
head_sampling_rate = 1.0
destinations = ["firetiger-traces"]

[observability.logs]
enabled = true
head_sampling_rate = 1.0
destinations = ["firetiger-logs"]
```

4. Deploy with `wrangler deploy`

### OpenTelemetry SDK (fallback)
If no deployment platform CLI is available, add OTEL instrumentation directly to the code:

**Node.js / Next.js:**
1. Add dependencies to `package.json`
2. Create `instrumentation.ts` with OTLP exporter configured with Firetiger credentials
3. Add environment variables to `.env.local`

**Python:** Add `opentelemetry-*` packages and configure OTLP exporter.

**Go:** Add `go.opentelemetry.io/*` packages and configure tracer provider.

## Step 6: Subscribe

Before creating agents, check if the user has an active subscription.

Call `get_subscription_status`:
- If **active** or **trialing**: proceed to Step 7
- If **none** or **canceled**:
  1. Call `get_checkout_url` to get a Stripe checkout URL
  2. **Automatically open the URL** in the user's browser using `open "URL"` (macOS) or `xdg-open "URL"` (Linux)
  3. Tell the user: "Opening Firetiger checkout in your browser. The Bootstrap plan is free ($0/month). Complete checkout and return here when done."
  4. STOP and wait for the user to respond (the success page will auto-close after payment)
  5. When the user responds, call `get_subscription_status` to verify, then proceed

## Step 7: Create Monitoring Agent

Use the `create_agent_with_goal` MCP tool to create an agent based on the detected stack:

For **Next.js/React**:
```
Goal: "Monitor this Next.js application for API route errors, slow page loads, and database query issues. Alert on error rate spikes and p95 latency increases."
```

For **Python API**:
```
Goal: "Monitor this Python API for request errors, slow endpoints, and exception patterns. Track database query performance and alert on anomalies."
```

For **Go service**:
```
Goal: "Monitor this Go service for errors, goroutine issues, and latency problems. Track memory usage patterns and alert on degradation."
```

### Handling Planner Questions

The tool returns the planner conversation. If the planner asked a question (e.g., "Which database should I monitor?"):
1. Answer the question on behalf of the user based on what you detected in the codebase
2. Use `send_agent_message` with the `session` from the tool output to send your answer
3. The tool will wait for the planner to finish and return the updated conversation

## Step 8: Show Summary

After completing setup, show:
1. What changes were made (list files modified)
2. Environment variables that need to be set in production
3. Connections configured (GitHub, Slack, etc.)
4. Agent created and its monitoring focus
5. Link to the Firetiger dashboard
6. Next steps (run install command, deploy, etc.)

## Important Notes

- **Make changes automatically** - Only ask for confirmation if genuinely uncertain
- **Never commit credentials** - Add credential files to `.gitignore`
- **Prefer environment variables** - Use OTEL standard env vars when possible
- **Show diffs** - Let user review changes before saving
- **Detect existing setup** - Don't duplicate instrumentation if already present
- **Connections are optional** - Don't block on connection failures
