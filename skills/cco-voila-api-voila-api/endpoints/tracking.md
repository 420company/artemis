# Tracking & Information Endpoints

Endpoints for shipment tracking, listing history, and retrieving documents.

---

## 1. Real-time Track

`POST /api/couriers/v1/{courier}/track`

Retrieves real-time tracking information directly from the courier.

```typescript
interface TrackRequest {
  /** The tracking code of the shipment. */
  tracking_code: string;
  /** Some couriers require the destination postcode for tracking. */
  postcode?: string;
  /** Any other courier-specific tracking fields. */
  [key: string]: any;
}

interface TrackingEvent {
  date: string;
  time: string;
  location: string;
  description: string;
  status: string;
}

interface TrackResponse {
  success: boolean;
  tracking_code: string;
  status: string;
  events: TrackingEvent[];
}
```

---

## 2. Detailed Tracking History (Multi-step)

Provides comprehensive tracking history and the original shipment metadata. This is a two-step process.

### Step 1: Get Tracking Identifiers
`POST /api/couriers/v1/get-tracking-identifiers`

```typescript
interface GetTrackingIdentifiersRequest {
  tracking_code: string;
}

interface TrackingIdentifier {
  tracking_request_id: number;
  tracking_request_hash: number;
  postcode: string;
  reference: string;
}

type GetTrackingIdentifiersResponse = TrackingIdentifier[];
```

### Step 2: Get Detailed Tracking
`POST /api/couriers/v1/get-tracking`

```typescript
interface GetDetailedTrackingRequest {
  /** Obtained from the "Get Tracking Identifiers" endpoint. */
  tracking_request_id: number;
  /** Obtained from the "Get Tracking Identifiers" endpoint. */
  tracking_request_hash: number;
}

interface DetailedTrackingResponse {
  tracking_code: string;
  status: string;
  events: TrackingEvent[];
  /** The original request data used to create the label. */
  shipment_request: any;
  /** The original response from the courier. */
  shipment_response: any;
}
```

---

## 3. Queue Tracking

`POST /api/couriers/v1/{courier}/queue-tracking`

Add an existing tracking code to the Voila tracking engine. Use this for shipments **not created via the Voila label API** (e.g., manually booked shipments) where you still want status updates tracked.

```typescript
interface QueueTrackingRequest {
  shipment: {
    /** Array of tracking codes to monitor. */
    tracking_codes: string[];
    /** The date the shipment was collected by the courier. */
    collection_date: string;
    ship_to: {
      country_iso: string;
      postcode: string;
    };
    /** Any courier-specific data required for tracking (e.g., account numbers). */
    courier?: Record<string, any>;
  };
}
```

---

## 4. Update Tracking Status (Manual)

`POST /api/shipments/{createLabelShipmentId}/update-tracking-status`

Manually updates the tracking status of a shipment. Useful for custom or manually tracked shipments.

**URL Parameter:** `createLabelShipmentId` — The internal shipment ID.

```typescript
interface UpdateTrackingStatusRequest {
  /**
   * The tracking code to update.
   * If not provided, the first tracking code of the shipment will be used.
   */
  tracking_code?: string;
  /** A description for the tracking event. */
  event_description: string;
  /**
   * A numeric status code representing the tracking state.
   * Examples: 1 (Booked), 19 (Custom).
   */
  tracking_status_code: number;
  /**
   * The date and time the event occurred.
   * Format: 'YYYY-MM-DDTHH:MM:SS' (e.g., '2024-08-15T11:11:11').
   */
  event_date: string;
}
```

---

## 5. List Shipments

`GET /api/shipments.json`

Returns a paginated list of shipments created by your API account.

**Query Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `archive` | `boolean` | If true, searches the archived shipments database. |
| `dc_request_id` | `string` | Filter by the internal request log ID. |
| `reference` | `string` | Filter by your internal reference. |
| `ship_to_email` | `string` | Filter by recipient email address. |
| `startDateFilter` | `string` | Start date for creation time (e.g., "2024-01-01"). |
| `endDateFilter` | `string` | End date for creation time. |
| `tracking_code` | `string` | Filter by a specific tracking code. |
| `cancelled` | `"true" \| "false"` | Filter by cancellation status. |
| `page` | `number` | Page number for pagination. Defaults to 1. |

```typescript
interface ShipmentRecord {
  id: number;
  courier: string;
  /** List of tracking codes for the shipment. */
  tracking_codes: string[];
  reference: string;
  ship_to_postcode: string;
  created_at: string;
  cancelled: boolean;
  /** The original request data used to create the shipment. */
  request_shipment: any;
}

interface ListShipmentsResponse {
  shipments: ShipmentRecord[];
  page: number;
  /** Number of shipments in this page. */
  count: number;
  /** Max shipments per page (usually 50). */
  max_count: number;
}
```

---

## 6. Shipment Summary PDF

`POST /api/couriers/v1/shipment-summary`

Generates a PDF summary for a group of shipments. Optionally triggers manifesting for these shipments.

```typescript
interface ShipmentSummaryRequest {
  /** Array of your internal references. */
  references: string[];
  /** If true, triggers a manifest request for all couriers/authentications in the summary. */
  manifest?: boolean;
}

interface ShipmentSummaryResponse {
  /** URL to the generated PDF summary. */
  url: string;
}
```

---

## 7. Document Regeneration

Re-generates shipping documents from the original request data.

### Regenerate Commercial Invoice
`GET /api/commercial-invoice/{request_id}`

- **`request_id`**: The `dc_request_id` from the original create-label response.
- **Query Parameter:** `copy_count` (optional, integer 1–100) — generates and merges multiple copies.

### Regenerate Packing Slip
`GET /api/packing-slip/{request_id}`

- **`request_id`**: The `dc_request_id` from the original create-label response.

Both return:
```typescript
interface RegenerateDocumentResponse {
  /** Temporary S3 URL to the generated PDF. */
  url: string;
  /** Internal file key. */
  key: string;
}
```
