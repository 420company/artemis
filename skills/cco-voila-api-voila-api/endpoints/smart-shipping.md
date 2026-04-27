# Smart Shipping Endpoints

Automatically select courier services based on your configured logic.

---

## 1. Simulate Rule Evaluation

`POST /api/couriers/v1/smart-shipping/get-rules`

Simulates which Smart Shipping rules would be applied to a specific shipment **without** creating a label. Useful for debugging your rule configuration.

**Input Schema:** Identical to [Create Label Request](./labeling.md).

```typescript
interface MatchingRule {
  rule_id: number;
  rule_name: string;
  rule_group: string;
  priority: number;
  main_courier: string;
  main_service_id: string;
  main_auth_company?: string;
  failover_courier?: string;
  failover_service_id?: string;
  failover_auth_company?: string;
  return_courier?: string;
  return_service_id?: string;
  return_auth_company?: string;
}

interface GetMatchingRulesResponse {
  rules: MatchingRule[];
  /** Any errors encountered during rule evaluation. */
  smart_shipping_errors: string[];
}
```

---

## 2. Smart Shipping Groups

Groups organize your smart shipping rules. Rules within a group are evaluated by priority. A group can be set to `split_parcels`, which will cause each parcel in a multi-parcel shipment to be sent as a separate label request.

- **List Groups:** `GET /api/smart-shipping-group`
- **Get Group:** `GET /api/smart-shipping-group/{id}`
- **Create Group:** `POST /api/smart-shipping-group`
- **Update Group:** `PATCH /api/smart-shipping-group/{id}` (all fields optional)
- **Delete Group:** `DELETE /api/smart-shipping-group/{id}`

> **Note:** A group cannot be deleted if it still has rules assigned to it.

```typescript
interface SmartShippingGroupRequest {
  /** The name of the group. Must be unique per API user. */
  name: string;
  /**
   * If true, multi-parcel shipments routed through this group will be split
   * into individual label requests.
   */
  split_parcels?: boolean;
}
```

---

## 3. Smart Shipping Rules

Rules define the conditions under which a specific courier and service should be used.

- **List All Rules & Groups:** `GET /api/smart-shipping` — Returns all groups and their rules.
- **Create Rule:** `POST /api/smart-shipping`
- **Update Rule:** `PATCH /api/smart-shipping/{id}` — All fields optional.
- **Delete Rule:** `DELETE /api/smart-shipping/{id}`

### Rule Schema

```typescript
interface SmartShippingRuleRequest {
  // --- Required fields ---
  rule_name: string;
  smart_shipping_group_id: number;
  priority: number;
  active: boolean;
  main_courier: string;
  main_service_id: string;

  // --- Optional courier targets ---
  main_auth_company?: string;
  failover_courier?: string;
  failover_service_id?: string;
  failover_auth_company?: string;
  return_courier?: string;
  return_service_id?: string;
  return_auth_company?: string;

  // --- Weight conditions (in kg) ---
  /** Min weight per parcel. */
  rule_weight_min?: number;
  /** Max weight per parcel. */
  rule_weight_max?: number;
  /** Min total combined weight of all parcels. */
  rule_total_shipment_weight_min?: number;
  /** Max total combined weight of all parcels. */
  rule_total_shipment_weight_max?: number;
  /** Min total combined volume. */
  rule_total_shipment_volume_min?: number;
  /** Max total combined volume. */
  rule_total_shipment_volume_max?: number;

  // --- Dimension conditions (in cm) ---
  rule_length_min?: number;
  rule_length_max?: number;
  rule_width_min?: number;
  rule_width_max?: number;
  rule_height_min?: number;
  rule_height_max?: number;
  rule_girth_min?: number;
  rule_girth_max?: number;
  rule_volume_min?: number;
  rule_volume_max?: number;

  // --- Value conditions ---
  /** Min value per parcel. */
  rule_value_min?: number;
  /** Max value per parcel. */
  rule_value_max?: number;
  /** Min total value of all parcels combined. */
  rule_shipment_value_min?: number;
  /** Max total value of all parcels combined. */
  rule_shipment_value_max?: number;

  // --- Geographic conditions ---
  /** Comma-separated list of postcodes to include. */
  rule_include_postcodes?: string;
  /** Comma-separated list of postcodes to exclude. */
  rule_exclude_postcodes?: string;
  /** Comma-separated ISO 2-letter country codes to allow. */
  rule_supported_countries?: string;

  // --- Address type ---
  rule_recipient_address_type?: 'residential' | 'commercial';

  // --- Item conditions (comma-separated values) ---
  rule_include_skus?: string;
  rule_exclude_skus?: string;
  rule_include_keywords?: string;
  rule_exclude_keywords?: string;
  rule_include_tags?: string;
  rule_exclude_tags?: string;
  rule_include_hs_codes?: string;
  rule_exclude_hs_codes?: string;
  rule_include_account_number?: string;
  rule_exclude_account_number?: string;
  rule_include_channels?: string;
  rule_exclude_channels?: string;

  // --- Shipping charge conditions ---
  rule_shipping_charge_min?: number;
  rule_shipping_charge_max?: number;
  rule_requested_shipping_service?: string;
  rule_delivery_instructions?: string;

  // --- Parcel count conditions ---
  rule_parcels_min?: number;
  rule_parcels_max?: number;

  // --- Time/date conditions ---
  /** HH:MM format. */
  rule_time_min?: string;
  /** HH:MM format. */
  rule_time_max?: string;
  /** Comma-separated day numbers; 1=Monday, 7=Sunday. */
  rule_include_days?: string;
  rule_exclude_days?: string;

  // --- Reference/order matching ---
  rule_reference?: string;
  rule_order_id?: string;

  // --- Collection date conditions ---
  rule_collection_date_start?: string;
  rule_collection_date_end?: string;
  rule_collection_days?: string;
}
```
