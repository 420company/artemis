---
description: Add OpenTelemetry instrumentation to send telemetry to Firetiger
user-invocable: true
---

# Firetiger Instrument

You are adding OpenTelemetry instrumentation to this project to send telemetry data to Firetiger.

This is a focused skill that only handles instrumentation - use `/firetiger:setup` for the full setup including agent creation.

## Step 1: Get Credentials

Call the `get_ingest_credentials` MCP tool to get the OTLP endpoint and authorization header.

## Step 2: Detect Framework

Quickly identify the primary framework:
- Check `package.json` for Node.js projects
- Check `requirements.txt` / `pyproject.toml` for Python
- Check `go.mod` for Go
- Check `Cargo.toml` for Rust

## Step 3: Check Existing Instrumentation

Before adding new instrumentation, check if OpenTelemetry is already set up:
- Search for `@opentelemetry` imports (Node.js)
- Search for `opentelemetry` imports (Python)
- Search for `go.opentelemetry.io` imports (Go)

If already instrumented, offer to update the exporter configuration instead of adding new instrumentation.

## Step 4: Add Instrumentation

Add the minimal instrumentation needed based on the framework.

### Node.js (any framework)

Install packages:
```bash
npm install @opentelemetry/api @opentelemetry/sdk-node @opentelemetry/auto-instrumentations-node @opentelemetry/exporter-trace-otlp-http
```

Create `tracing.ts`:
```typescript
import { NodeSDK } from '@opentelemetry/sdk-node'
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'

const sdk = new NodeSDK({
  serviceName: process.env.OTEL_SERVICE_NAME || 'my-service',
  traceExporter: new OTLPTraceExporter({
    url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
    headers: {
      Authorization: process.env.OTEL_EXPORTER_OTLP_HEADERS?.replace('Authorization=', '') || ''
    }
  }),
  instrumentations: [getNodeAutoInstrumentations()]
})

sdk.start()
```

### Python

Install packages:
```bash
pip install opentelemetry-sdk opentelemetry-exporter-otlp opentelemetry-instrumentation
```

Create `tracing.py`:
```python
import os
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource

def setup_tracing():
    resource = Resource.create({"service.name": os.getenv("OTEL_SERVICE_NAME", "my-service")})
    provider = TracerProvider(resource=resource)

    exporter = OTLPSpanExporter(
        endpoint=os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT"),
        headers={"Authorization": os.getenv("OTEL_EXPORTER_OTLP_HEADERS", "").replace("Authorization=", "")}
    )

    provider.add_span_processor(BatchSpanProcessor(exporter))
    trace.set_tracer_provider(provider)

setup_tracing()
```

### Go

Add to `go.mod` dependencies and create initialization in `main.go`:
```go
package main

import (
    "context"
    "os"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
    "go.opentelemetry.io/otel/sdk/resource"
    sdktrace "go.opentelemetry.io/otel/sdk/trace"
    semconv "go.opentelemetry.io/otel/semconv/v1.17.0"
)

func initTracer() func() {
    ctx := context.Background()

    exporter, _ := otlptracehttp.New(ctx,
        otlptracehttp.WithEndpoint(os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT")),
        otlptracehttp.WithHeaders(map[string]string{
            "Authorization": os.Getenv("OTEL_EXPORTER_OTLP_HEADERS"),
        }),
    )

    tp := sdktrace.NewTracerProvider(
        sdktrace.WithBatcher(exporter),
        sdktrace.WithResource(resource.NewWithAttributes(
            semconv.SchemaURL,
            semconv.ServiceName(os.Getenv("OTEL_SERVICE_NAME")),
        )),
    )

    otel.SetTracerProvider(tp)

    return func() { tp.Shutdown(ctx) }
}
```

## Step 5: Configure Environment

Add environment variables. Suggest adding to:
- `.env.local` for local development
- Deployment platform (Vercel, Railway, etc.) for production
- `docker-compose.yml` if using Docker

Required variables:
```
OTEL_EXPORTER_OTLP_ENDPOINT=<from credentials>
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic <from credentials>
OTEL_SERVICE_NAME=<project-name>
```

## Step 6: Update .gitignore

Ensure credential files are not committed:
```
.env.local
.env.*.local
```

## Step 7: Summary

Show what was done:
1. Packages added
2. Files created/modified
3. Environment variables needed
4. Next steps (install deps, restart server)
