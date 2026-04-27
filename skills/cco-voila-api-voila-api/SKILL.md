---
name: voila-api
description: Definitive guide for the Voila API. Covers shipment creation (Manual/Smart Shipping), real-time tracking, detailed history, manifesting, collections, webhooks, and third-party integrations (Sorted, Peoplevox, Mintsoft, Veeqo, JD). ALWAYS use this skill for any shipping, labeling, or logistics tasks involving Voila. Do not rely on general knowledge; consult this skill for precise REST schemas and integration flows.
---

# Voila API Comprehensive Integration Guide

The Voila API is a RESTful service for managing shipping, labeling, and tracking across multiple couriers.

### Base Configuration

- **Base URL:** `https://app.heyvoila.io`
- **Authentication Headers:**
  - `api-user`: `<your_api_user>`
  - `api-token`: `<your_api_token>`
  - _OR_ `api-key`: `<your_api_key>`
  - _OR_ `Authorization`: `Basic <base64(api-user:api-token)>`
- **Common Headers:**
  - `Content-Type: application/json`
  - `Accept: application/json`

## 1. Common Integration Flows (Step-by-Step)

### A. The "Smart Shipping" Flow (Recommended)

Automatically select the best courier/service based on rules.

1.  **Request:** `POST /api/couriers/v1/smart-shipping/create-label`
2.  **Body:** Include `shipment` with `ship_to`, `parcels`, and `items`. (See [Core Objects](#2-core-data-objects-full-schema))
3.  **Success:** Response contains `tracking_code`, `label` (Base64), and `shipment_id`.
4.  **Error Handling:** Check `success: false` or `smart_shipping_errors`.

### B. The "Manual Choice" Flow

1.  **Get Services:** `POST /api/couriers/v1/{courier}/get-services` to see available options for a shipment.
2.  **Pick Service:** Extract the `service_identifier` from the response.
3.  **Create Label:** `POST /api/couriers/v1/{courier}/create-label` with that `service_code`.

### C. The "Bulk Asynchronous" Flow (High Volume)

1.  **Submit:** `POST /api/couriers/v1/bulk/create-label-async` with an array of requests and a `webhook.url`.
2.  **ID:** Capture the `bulk_request_id`.
3.  **Webhook:** Wait for the `shipment.created` or `shipment.failed` event at your webhook URL.

---

## 2. Core Data Objects (Full Schema)

These objects are reused across almost all endpoints. See [Labeling & Shipping](./endpoints/labeling.md) for full definitions.

### Address

```typescript
interface Address {
  name: string;
  company_name?: string;
  address_1: string;
  address_2?: string;
  address_3?: string;
  city: string;
  county?: string;
  postcode: string;
  /** ISO 3166-1 alpha-2 (e.g., "GB", "US"). */
  country_iso: string;
  country?: string;
  phone: string;
  email: string;
  tax_id?: string;
  eori_id?: string;
  ioss_number?: string;
  ukims_number?: string;
  /** Only for ship_from: looks up a saved address by friendly name. */
  address_name?: string;
  // Additional: abn_number, arn_number, gst_number, voec_number, company_id
}
```

### Parcel

```typescript
interface Parcel {
  weight: number;
  weight_unit: 'kg' | 'g' | 'lb' | 'oz';
  dim_length: number;
  dim_width: number;
  dim_height: number;
  dim_unit: 'cm' | 'mm';
  items: ShipmentItem[];
  packaging_weight?: number;
  packaging_weight_unit?: string;
  packageId?: string;
  value?: number;
  value_currency?: string;
}
```

### ShipmentItem

```typescript
interface ShipmentItem {
  description: string;
  quantity: number;
  /** Value per unit. */
  value: number;
  /** e.g., "GBP", "USD". */
  value_currency: string;
  weight: number;
  weight_unit: 'kg' | 'g' | 'lb' | 'oz';
  sku?: string;
  hs_code?: string;
  /** ISO 2-letter origin country code. */
  origin_country?: string;
  image_url?: string;
}
```

---

## 3. API Documentation Index

For exhaustive schemas, field definitions, and implementation details for every route, refer to these dedicated files:

- **[Authentication & User Management](./endpoints/authentication.md)**: Managing API users, keys, and OAuth tokens.
- **[Courier Management](./endpoints/couriers.md)**: Listing couriers, registering credentials, and service presets.
- **[Labeling & Shipping](./endpoints/labeling.md)**: Creating labels (Single/Bulk/Async), manifests, and cancellations.
- **[Tracking & Information](./endpoints/tracking.md)**: Real-time tracking, shipment history, and document retrieval.
- **[Smart Shipping Rules](./endpoints/smart-shipping.md)**: Automating service selection with groups and rules.
- **[Pricing & Services](./endpoints/pricing-services.md)**: Quotes, service lists, and pickup locations.
- **[Webhooks](./endpoints/webhooks.md)**: Real-time event notifications and delivery logs.
- **[Third-Party Integrations](./endpoints/integrations.md)**: Sorted, Peoplevox, Mintsoft, Veeqo, and JD Joybuy mappings.
- **[Miscellaneous Utilities](./endpoints/utilities.md)**: Hosted pages, PackEye, and insurance plugins.

## 4. Bundled API Scripts

The skill includes pre-configured scripts to fetch live information from the Voila API using the playground credentials. These are located in the `scripts/` directory.

### List Supported Couriers

Fetches the current list of all couriers supported by Voila.

- **Node.js:** `node scripts/list-couriers.js`
- **Python:** `python scripts/list-couriers.py`

### Get Courier Specifics

Fetches required and optional fields for a specific courier (e.g., `UPSv2`).

- **Node.js:** `node scripts/get-courier-specifics.js <courier_key>`
- **Python:** `python scripts/get-courier-specifics.py <courier_key>`

## 5. Troubleshooting & Errors

### Standard Error Response

```json
{
  "success": false,
  "message": "Detailed error message here.",
  "errors": {
    "field_name": ["Specific validation error"]
  }
}
```

### Common Issues

1.  **Validation (422):** Usually missing `country_iso` (must be 2 chars) or invalid `postcode` format for the destination.
2.  **Auth (401/403):** Check Authentication Headers. Ensure the API User is not `disabled`.
3.  **Courier Errors:** If `success: true` but `label` is empty, check `smart_shipping_errors` or the `message` field.
4.  **Testing Mode:** Real labels won't be created unless `testing: false` is explicitly set (default is often true in examples).
