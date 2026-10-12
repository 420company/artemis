# Labeling & Shipping Endpoints

Comprehensive guide to creating labels, manifests, and managing shipment status.

---

## Shared Types

These interfaces are referenced throughout this file and other endpoint files.

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
  /** ISO 3166-1 alpha-2 country code (e.g., "GB", "US"). */
  country_iso: string;
  /** Full country name (optional, ISO is preferred). */
  country?: string;
  phone: string;
  email: string;
  /** Tax/VAT registration number. */
  tax_id?: string;
  eori_id?: string;
  ioss_number?: string;
  ukims_number?: string;
  company_id?: string;
  /** Australian Business Number. */
  abn_number?: string;
  /** Australian Registration Number. */
  arn_number?: string;
  /** Goods and Services Tax number. */
  gst_number?: string;
  /** VOEC number for Norway. */
  voec_number?: string;
  /**
   * Friendly name used to look up a saved address in your account.
   * Only applicable for 'ship_from'.
   */
  address_name?: string;
}

interface ShipmentItem {
  description: string;
  quantity: number;
  /** Value per unit. */
  value: number;
  /** Currency code (e.g., "GBP", "USD", "EUR"). */
  value_currency: string;
  weight: number;
  weight_unit: 'kg' | 'g' | 'lb' | 'oz';
  sku?: string;
  hs_code?: string;
  /** ISO 2-letter code for origin country. */
  origin_country?: string;
  image_url?: string;
}

interface Parcel {
  weight: number;
  weight_unit: 'kg' | 'g' | 'lb' | 'oz';
  dim_length: number;
  dim_width: number;
  dim_height: number;
  dim_unit: 'cm' | 'mm';
  items: ShipmentItem[];
  /** Weight of the packaging itself. */
  packaging_weight?: number;
  packaging_weight_unit?: string;
  /** Custom parcel identifier. */
  packageId?: string;
  /** Total value of the parcel contents. */
  value?: number;
  value_currency?: string;
}
```

---

## 1. Create Label (Standard)

`POST /api/couriers/v1/{courier}/create-label`

**URL Parameters:**
- `courier`: (Required) The courier key (e.g., `RoyalMail`, `UPSv2`, `AmazonShipping`).

### Input Schema

```typescript
interface CreateLabelRequest {
  shipment: {
    ship_to: Address;
    /** If omitted, the default sender address for the API user will be used. */
    ship_from?: Address;
    parcels: Parcel[];
    courier: {
      /** The specific service code for the courier. */
      service_code: string;
      /** Friendly name for the service. */
      friendly_service_name?: string;
      /** The registered auth_company name to use for this shipment. */
      auth_company?: string;
      /** Cutoff time for same-day collection (e.g., "17:30"). */
      collection_cutoff?: string;
      /** Whether to calculate the next business day for collection. */
      next_business_day?: boolean;
      /** Whether to allow collections on weekends. */
      allow_weekend_collection?: boolean;
      /** Specific address for courier pickup if different from ship_from. */
      collection_address?: Address;
      /** Whether to explicitly trigger a collection booking request. */
      book_collection?: boolean;
      /** Terms of trade (e.g., "DAP", "DDP"). */
      trade_terms?: string;
      incoterms?: string;
      /** Any other courier-specific fields — check "Get Courier Specifics". */
      [key: string]: any;
    };
    /** Primary internal reference. */
    reference?: string;
    /** Secondary internal reference. */
    reference_2?: string;
    /** External order ID. */
    order_id?: string;
    /** Alternative external order ID. */
    order_alt_id?: string;
    /** Requested collection date (ISO 8601, e.g. "2024-10-27"). */
    collection_date?: string;
    /** Overrides the courier-level collection cutoff. */
    collection_cutoff?: string;
    /** Use a pre-configured service ID to populate courier settings. */
    dc_service_id?: string;
    /** General description of the shipment contents. */
    parcel_description?: string;
    /**
     * If provided, the system will attempt to split items from a single parcel
     * into this many parcels.
     */
    parcel_count?: number;
    /** The amount charged to the end customer for shipping. */
    shipping_charge?: string | number;
    /** Delivery instructions for the courier. */
    delivery_instructions?: string;
    /** Whether to generate a commercial invoice PDF. */
    generate_commercial_invoice?: boolean;
    commercial_invoice_details?: {
      vat_number?: string;
      eori_number?: string;
      company_number?: string;
      receiver_reference?: string;
      /** Document size (e.g., "6x4", "A4"). */
      size?: string;
      billing_address?: Address;
    };
    gift_note?: {
      note: string;
    };
    /** Preferred label format. */
    label_format?: 'pdf' | 'zpl' | 'png';
    /** If true, returns an existing label if one with the same reference and courier exists. */
    return_duplicate?: boolean;
    /** If true, cancels an existing label with the same reference before creating a new one. */
    cancel_or_return_duplicate?: boolean;
    /** Whether to apply Anansi shipping insurance. */
    plugin_use_anansi?: boolean;
    /** Whether to block the request if Anansi validation fails. */
    plugin_validate_anansi?: boolean;
  };
  /** Whether this is a test/sandbox request. */
  testing?: boolean;
  /** Whether to apply default address formatting rules. */
  format_address_default?: boolean;
  /** Custom settings for address formatting. */
  format_address_settings?: Record<string, any>;
}
```

### Output Schema

```typescript
interface CreateLabelResponse {
  /** Array of tracking codes, one per parcel. */
  tracking_codes: string[];
  /** Temporary S3 URL to the generated label. */
  uri: string;
  /** Internal file key for the label PDF. */
  key: string;
  /** Format of the label. */
  type: 'pdf' | 'zpl' | 'png';
  /** The courier key used for the shipment. */
  courier: string;
  /** The dc_service_id of the preset used. */
  dc_service_id?: string;
  /** Internal request log ID, useful for troubleshooting. */
  dc_request_id: number;
  /** Indicates if an existing label was returned instead of creating a new one. */
  duplicate?: boolean;
  /** The ID of the original CreateLabelShipment if this is a duplicate. */
  duplicate_of?: number;
  /** Commercial invoice document (if generated). */
  commercial_invoice?: {
    /** Temporary S3 URL to the commercial invoice PDF. */
    url: string;
    /** Internal file key. */
    key: string;
  };
  /** Return label for courier (if requested and supported). */
  return?: {
    uri: string;
    key: string;
  };
  /** Any extra data the courier returned. */
  courier_specifics?: Record<string, any>;
}
```

---

## 2. Smart Shipping Label Creation

`POST /api/couriers/v1/smart-shipping/create-label`

The input schema is identical to **Create Label**, but the `courier` object within the `shipment` can be omitted or partially filled. The following additional fields control rule selection:

```typescript
interface SmartShippingCreateLabelRequest extends CreateLabelRequest {
  shipment: CreateLabelRequest['shipment'] & {
    /**
     * The name of the Smart Shipping group to use.
     * If your account only has one group, this can be omitted.
     */
    smart_shipping_group?: string;
    /**
     * The name of a specific Smart Shipping rule to use, bypassing group selection.
     */
    smart_shipping_name?: string;
    /**
     * Whether to split each parcel in the request into its own separate label request.
     * Overrides the group-level split_parcels setting.
     */
    split_parcels?: boolean;
  };
  /**
   * A list of group/rule names to try in order. The system will attempt each one
   * in sequence and return the first successful label.
   */
  try_list?: string[];
  /**
   * If true, returns the matching rule data instead of creating a label.
   * Used by the Sorted integration's cheapest-quote flow.
   */
  return_rule?: boolean;
}
```

The output schema is the same as **Create Label**.

---

## 3. Bulk Label Creation (Sync)

`POST /api/couriers/v1/bulk/create-label`

```typescript
interface BulkCreateLabelRequest {
  /** Array of CreateLabelRequest objects. */
  requests: CreateLabelRequest[];
  /** If true, merges all generated labels into a single PDF. */
  merge?: boolean;
}
```

---

## 4. Bulk Label Creation (Async)

`POST /api/couriers/v1/bulk/create-label-async`

Recommended for 20+ shipments. Returns a `bulk_request_id` immediately. Use webhooks for notification on completion.

```typescript
interface BulkCreateLabelAsyncRequest {
  requests: CreateLabelRequest[];
  /** Optional webhook to notify when processing is complete. */
  webhook?: {
    url: string;
    headers?: Record<string, string>;
  };
  /** If true, merges all labels into a single PDF. */
  merge?: boolean;
}

interface BulkCreateLabelAsyncResponse {
  success: boolean;
  bulk_request_id: number;
}
```

---

## 5. Cancel Label

`POST /api/couriers/v1/{courier}/cancel-label`

```typescript
interface CancelLabelRequest {
  /** Required if create_label_shipment_id is not provided. */
  tracking_code?: string;
  /** Required if tracking_code is not provided. */
  create_label_shipment_id?: number;
}

interface CancelLabelResponse {
  success: boolean;
}
```

---

## 6. Create Manifest

`POST /api/couriers/v1/{courier}/create-manifest`

Generates a manifest for a group of shipments, often required by couriers at end-of-day.

```typescript
interface CreateManifestRequest {
  /** Array of internal shipment IDs to include. */
  shipment_ids?: number[];
  tracking_codes?: string[];
}

interface CreateManifestResponse {
  success: boolean;
  manifest_id: string;
  /** Base64 encoded manifest document or URL. */
  manifest_document: string;
}
```

---

## 7. Collection Management

- **Schedule Collection:** `POST /api/couriers/v1/{courier}/create-collection`
  - Input schema is courier-specific but generally requires an address and collection date.
- **Cancel Collection:** `POST /api/couriers/v1/{courier}/cancel-collection`
  - Cancels a previously scheduled collection.

---

## 8. Shipment Status Updates

### Mark Shipment Packed
`POST /api/couriers/v1/mark-shipment-packed`

The shipment is looked up by `reference` and must currently be in the "Booked" state.

```typescript
interface MarkShipmentPackedRequest {
  reference: string;
}
```

### Mark Shipment Cancelled
Two variants:

- `POST /api/couriers/v1/mark-shipment-cancelled` — Updates internal status only. Finds the shipment by `reference` or `dc_request_id`.
- `POST /api/couriers/v1/{courier}/mark-shipment-cancelled` — Can optionally trigger a real cancellation with the courier if `cancel_label: true`.

```typescript
interface MarkShipmentCancelledRequest {
  /** Required for the non-courier route. */
  reference?: string;
  /** The DC request log ID. Can be used instead of reference. */
  dc_request_id?: number;
  /**
   * The internal CreateLabelShipment ID.
   * Only for the courier-specific route.
   */
  create_label_shipment_id?: number;
  /**
   * If true, triggers an actual cancellation request to the courier's API.
   * Only for the courier-specific route.
   */
  cancel_label?: boolean;
}
```

### Bulk Mark Cancelled
`POST /api/couriers/v1/bulk/mark-shipment-cancelled`

```typescript
interface BulkCancelRequest {
  requests: Array<{
    reference?: string;
    dc_request_id?: number;
    create_label_shipment_id?: number;
  }>;
}
```
