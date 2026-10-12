# Third-Party Integration Endpoints

Specialized endpoints for integrating with other logistics and WMS platforms.

---

## 1. Sorted (Electio) Compatibility

Endpoints that map the Sorted API structure to Voila's internal shipping logic.

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/couriers/v1/third-parties/sorted/create-shipment` | Initializes a shipment record. No booking is made yet. Returns a link to allocate. |
| `PUT` | `/api/couriers/v1/third-parties/sorted/allocate-shipment/{requestId}` | Performs the actual booking using Smart Shipping rules. |
| `PUT` | `/api/couriers/v1/third-parties/sorted/allocate-shipment-cheapest/{requestId}` | Simulates Smart Shipping and returns the cheapest service. |
| `GET` | `/api/couriers/v1/third-parties/sorted/get-shipment/{requestId}/{fileType}` | Retrieves the generated label. `fileType` is `PDF`, `PNG`, or `ZPL`. |
| `GET` | `/api/couriers/v1/third-parties/sorted/get-labels/{requestId}/{packageId}` | Retrieves the label for a specific package within a multi-parcel shipment. |
| `DELETE` | `/api/couriers/v1/third-parties/sorted/cancel-label/{requestId}` | Cancels the shipment and its label. |
| `PUT` | `/api/couriers/v1/third-parties/sorted/ready-to-ship/{readyToShip}` | Placeholder returning a "ReadyToShip" status for Sorted API compatibility. |
| `GET` | `/api/couriers/v1/third-parties/sorted/get-courier-services` | Returns a placeholder list of available carrier services. |
| `PUT` | `/api/couriers/v1/third-parties/sorted/get-manifest` | Generates a manifest for one or more consignments. |

**Allocate Shipment body:**
```typescript
interface SortedAllocateRequest {
  /** Optional: the specific Smart Shipping group to use. */
  smartShippingGroup?: string | number;
}
```

---

## 2. Peoplevox Integration

Allows linking and creating labels for Peoplevox WMS.

### Link Authentication
`POST /api/couriers/v1/third-parties/peoplevox/link-auth`

```typescript
interface PeoplevoxLinkAuthRequest {
  /** The "Bearer <token>" authorization header value from Peoplevox. */
  peoplevox_authorization_header: string;
  /** The sender address. See Address type in labeling.md. */
  ship_from: Address;
}
```

### Create Label
`POST /api/couriers/v1/third-parties/peoplevox/create-label`

Input follows the [Peoplevox WMS Endpoint Specification](https://peoplevox.help.descartesservices.com/building-your-endpoint), primarily using the `despatchPackage` object.

---

## 3. Mintsoft Integration

Integration for Mintsoft WMS shipments.

### Create Shipment
`POST /api/couriers/v1/third-parties/mintsoft/CreateShipment`

```typescript
interface MintsoftCreateShipmentRequest {
  ShipmentId: string;
  OrderNumber: string;
  ExternalOrderReference: string;
  CourierName: string;
  ServiceCode: string;
  Testing: boolean;
  ShipFrom: MintsoftAddress;
  ShipTo: MintsoftAddress;
  Parcels: MintsoftParcel[];
  DeliveryNotes?: string;
  Client?: string;
}

interface MintsoftAddress {
  Name: string;
  CompanyName: string;
  Phone: string;
  Email: string;
  AddressLine1: string;
  AddressLine2: string;
  AddressLine3: string;
  Town: string;
  PostCode: string;
  County: string;
  CountryCode: string;
  VATNumber?: string;
  EORINumber?: string;
  IOSSNumber?: string;
}

interface MintsoftParcel {
  Length: number;
  Width: number;
  Height: number;
  UnitOfLength: string;
  ParcelItems: MintsoftItem[];
}

interface MintsoftItem {
  SKU: string;
  Title: string;
  CustomsDescription?: string;
  CommodityCode?: string;
  Quantity: number;
  UnitPrice: { Amount: number; Currency: string };
  UnitWeight: number;
  UnitOfWeight: string;
  CountryOfManufacture: string;
}

interface MintsoftCreateShipmentResponse {
  Success: boolean;
  Shipment?: {
    MainTrackingNumber: string;
    LabelFormat: string;
    Packages: {
      TrackingNumber: string;
      TrackingUrl: string;
      ParcelNo: number;
      LabelAsBase64: string;
    }[];
  };
  ErrorMessages?: string[];
}
```

### Cancel Shipment
`DELETE /api/couriers/v1/third-parties/mintsoft/CancelShipment`

```typescript
interface MintsoftCancelShipmentRequest {
  TrackingNumber: string;
  CourierName: string;
  Testing?: boolean;
}
```

---

## 4. Veeqo Integration

Provides direct integration for Veeqo shipments.

### Get Quotes
`POST /api/couriers/v1/third-parties/veeqo/quotes`

```typescript
interface VeeqoQuote {
  code: string;
  name: string;
  price: number;
  currency: string;
  service_type: 'collection' | 'dropoff';
  delivery_estimate: string;
}

type VeeqoQuotesResponse = VeeqoQuote[];
```

### Create Shipment
`POST /api/couriers/v1/third-parties/veeqo/shipments`

Input matches the [Veeqo Shipment API spec](https://developer.veeqo.com/docs/shipping).

```typescript
interface VeeqoCreateShipmentResponse {
  tracking_number: string;
  /** Base64 encoded PDF label. */
  label: string;
  /** Base64 encoded commercial invoice PDF (if applicable). */
  commercial_invoice_label?: string;
}
```

### Cancel Shipment
`DELETE /api/couriers/v1/third-parties/veeqo/shipments/{tracking_code}`

---

## 5. JD (Joybuy) Integration

Endpoints for JD.com orders. Input is sent as **form-encoded data** with a `logistics_info` field containing a JSON string.

### Create Label
`POST /api/couriers/v1/smart-shipping/create-label-jd`

```typescript
interface JDLogisticsInfo {
  orderId: string;
  waybillCode?: string;
  currencyCode: string;
  weightUnits: string;
  sender: JDAddress;
  receiver: JDAddress;
  packageInfos: JDPackageInfo[];
  orderDetail?: {
    /** Mapped to smart_shipping_group in Voila. */
    serviceCode?: string;
  };
}

interface JDAddress {
  name: string;
  companyName: string;
  tel: string;
  mobile: string;
  email: string;
  address: string;
  address2?: string;
  address3?: string;
  city: string;
  zipCode: string;
  county: string;
  /** ISO 2-letter country code. */
  country: string;
  vatNumber?: string;
  eoriNumber?: string;
  iossNumber?: string;
}

interface JDPackageInfo {
  packageId: string;
  weight: number;
  length: number;
  width: number;
  height: number;
  goods: JDGood[];
}

interface JDGood {
  goodsNameEn: string;
  goodsCount: number;
  worth: number;
  currency: string;
  goodsWeight: number;
  goodsWeightUnits: string;
  goodsCode: string;
  hsCode: string;
}

interface JDCreateLabelResponse {
  isSuccess: boolean;
  logisticsProviderCode: string;
  waybillCode: string;
  orderId: string;
  labels: {
    labelType: string;
    packageID: string;
    trackingNumber: string;
    imageType: 'PDF';
    /** Base64 encoded PDF pages. */
    images: string[];
  }[];
  /** Error reason if isSuccess is false. */
  reason?: string;
}
```

### Cancel Label
`POST /api/couriers/v1/cancel-label-jd`
