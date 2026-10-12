# Webhooks Endpoints

Receive real-time notifications about events happening in your Voila account.

---

## 1. Webhook Resource

### List Webhooks
`GET /api/webhooks`

Supports `per_page` query parameter for pagination.

### Get Webhook Details
`GET /api/webhooks/{id}`

### Create Webhook
`POST /api/webhooks`

### Update Webhook
`PATCH /api/webhooks/{id}`

Input schema is the same as **Create Webhook**, but all fields are optional. Returns the updated `WebhookResponse`.

### Enable / Disable Webhook
- `PATCH /api/webhooks/{id}/enable`
- `PATCH /api/webhooks/{id}/disable`

Returns the updated `WebhookResponse`.

### Delete Webhook
`DELETE /api/webhooks/{id}`

Returns `204 No Content` on success.

---

### Webhook Schema

```typescript
interface CreateWebhookRequest {
  /** A friendly name for the webhook. */
  name: string;
  /** The event type to subscribe to. */
  event: 'shipment.created' | 'shipment.cancelled' | 'auth.registered' | 'shipment.tracked' | 'shipment.failed';
  /** The HTTP method to use for the notification. */
  method: 'POST' | 'PUT';
  /** Your endpoint URL that will receive the notification. */
  uri: string;
  /** Whether the webhook is enabled. Defaults to true. */
  is_active?: boolean;
  /** Optional custom HTTP headers to include in every notification. */
  headers?: Record<string, string>;
}

interface WebhookResponse {
  id: number;
  name: string;
  event: 'shipment.created' | 'shipment.cancelled' | 'auth.registered' | 'shipment.tracked' | 'shipment.failed';
  method: 'POST' | 'PUT';
  uri: string;
  is_active: boolean;
  headers: Record<string, string>;
  created_at: string;
  updated_at: string;
}
```

---

## 2. Webhook Jobs & Logs

Each time an event triggers a webhook, a "job" is created to handle delivery of the notification.

- **List Webhook Jobs:** `GET /api/webhooks/{webhook_id}/jobs` — Supports `per_page` query parameter.
- **Get Job Details:** `GET /api/webhooks/{webhook_id}/jobs/{job_id}`
- **Delete Webhook Job:** `DELETE /api/webhooks/{webhook_id}/jobs/{job_id}` — Returns `204 No Content`.
- **View Job Logs:** `GET /api/webhooks/{webhook_id}/jobs/{job_id}/logs` — Returns the actual HTTP request and response for the delivery attempt.

---

## 3. Notification Payload

When an event fires, a JSON payload is sent via HTTP to the configured `uri`.

```typescript
interface WebhookNotification {
  /** The ID of the webhook that fired. */
  id: number;
  event: 'shipment.created' | 'shipment.cancelled' | 'auth.registered' | 'shipment.tracked' | 'shipment.failed';
  data: {
    shipment_id: number;
    tracking_code: string;
    reference: string;
    courier: string;
    status: string;
  };
  created_at: string;
}
```

**Handling Best Practices:**
1. **Acknowledge quickly:** Respond with `200 OK` within 5 seconds.
2. **Retry logic:** If your server returns an error or times out, the system will retry the notification up to 3 times.
3. **Signature verification:** If you set a secret in `headers`, verify it on your server before processing the payload.
