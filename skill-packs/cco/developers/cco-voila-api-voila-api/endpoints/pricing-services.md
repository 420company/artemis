# Pricing & Services Endpoints

Retrieve available courier services and detailed shipping price quotes.

---

## 1. Get Available Services

`POST /api/couriers/v1/{courier}/get-services`

Returns the shipping services offered by a courier for a specific shipment. All shipment transformations (unit conversions, address formatting) are applied before being passed to the courier's API.

**Input Schema:** Identical to [Create Label Request](./labeling.md) (requires the `shipment` object).

```typescript
interface CourierService {
  /** The courier key. */
  service_courier: string;
  /** The courier's internal identifier for the service. Pass as service_code when creating a label. */
  service_identifier: string;
  /** A human-readable name for the service. */
  service_name: string;
  /** Estimated price for the service. */
  service_price: number;
  /** The currency for the price. */
  currency?: string;
}

type GetServicesResponse = CourierService[];
```

---

## 2. Get Shipping Price (Detailed Breakdown)

`POST /api/couriers/v1/{courier}/get-price`

Returns a detailed price breakdown for a specific shipment and service.

**Input Schema:** Identical to [Create Label Request](./labeling.md), with a `service_code` selected in the `courier` object.

If a courier only provides a single price, it will be mapped to both `base_price` and `total_price`.

```typescript
interface GetPriceResponse {
  /** The base shipping cost. */
  base_price: number;
  /** Any fuel surcharge applied. */
  fuel_price: number;
  /** Any other surcharges (e.g., peak, out-of-area). */
  surcharge_price: number;
  /** The final total price. */
  total_price: number;
  /** The currency for all price fields. */
  currency: string;
}
```

---

## 3. Get Pickup Locations

`POST /api/couriers/v1/{courier}/get-pickup-locations`

Returns a list of local pickup/drop-off points for a courier near the shipment destination.

```typescript
interface GetPickupLocationsRequest {
  shipment: {
    ship_to: {
      address_1: string;
      city: string;
      postcode: string;
      country_iso: string;
    };
  };
}

interface PickupLocation {
  id: string;
  name: string;
  address_1: string;
  city: string;
  postcode: string;
  distance?: number;
  distance_unit?: string;
  opening_hours?: any;
}

type GetPickupLocationsResponse = PickupLocation[];
```

---

## 4. Billing Quotes (Internal)

Retrieves pricing quotes based on your internal rate cards and billing rules. These are based on your configured pricing, not the live courier rates.

- **Cheapest Quote Only:** `POST /api/couriers/v1/billing-quote/lcr` — Returns a single `BillingQuote`.
- **All Quotes Sorted by Price:** `POST /api/couriers/v1/billing-quote/list` — Returns `BillingQuote[]`.

**Input Schema:** Identical to [Create Label Request](./labeling.md).

```typescript
interface BillingQuote {
  courier: string;
  service_name: string;
  service_code: string;
  price: number;
  currency: string;
}
```
