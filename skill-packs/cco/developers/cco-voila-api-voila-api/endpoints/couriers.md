# Courier Management Endpoints

Manage supported couriers and your authentication credentials for them.

---

## 1. List Supported Couriers

`GET /api/couriers/v1/list-couriers`

Returns a list of all couriers supported by the Voila platform.

```typescript
interface CourierInfo {
  key: string;
  name: string;
  logo: string;
  thumbnail: string;
  status: "production" | "beta" | "alpha";
  supports_returns: boolean;
  digital_customs: boolean;
  requires_manifest: boolean;
  tracking_only: boolean;
  sales_contact_email?: string;
  support_contact_email?: string;
  phone?: string;
  website?: string;
  description: string;
}

type ListCouriersResponse = {
  couriers: CourierInfo[];
};
```

---

## 2. List Registered Couriers

`GET /api/couriers/v1/list-registered-couriers`

Returns couriers you have already registered credentials for.

```typescript
interface RegisteredCourier {
  courier: string;
  testing: boolean;
  auth_company: string;
  tracking_only: boolean;
  /** Courier-specific authentication details (fields will be obfuscated). */
  auth_details: Record<string, any>;
}

type ListRegisteredCouriersResponse = RegisteredCourier[];
```

---

## 3. Get Authentication Rules

`GET /api/couriers/v1/{courier}/register-auth-rules`

Returns the required and optional fields needed to register authentication for a specific courier. Use this before calling **Register Courier Authentication** to know what to put in the `auth` object.

```typescript
/** Keys are field names; values are Laravel-style validation rules. */
interface AuthRulesResponse {
  [field: string]: string;
  // e.g. "account_number": "required|string|max:50"
  // e.g. "api_key": "required|string"
}
```

---

## 4. Register Courier Authentication

`POST /api/couriers/v1/{courier}/register-auth`

Registers your credentials for a specific courier.

```typescript
interface RegisterAuthRequest {
  /**
   * Object containing the authentication fields required by the courier.
   * Use the "Get Authentication Rules" endpoint to find what's needed.
   */
  auth: Record<string, any>;
  /**
   * A friendly name for this authentication (e.g., "Main Warehouse", "Returns Department").
   * Cannot contain underscores.
   */
  auth_company?: string;
  /** Whether this is a test/sandbox account. */
  testing?: boolean;
  /** If true, this authentication will only be used for tracking, not label creation. */
  tracking_only?: boolean;
}

interface RegisterAuthResponse {
  success: boolean;
}
```

---

## 5. Update Courier Authentication

`POST /api/couriers/v1/{courier}/update-auth`

Updates the credentials for an existing courier authentication.

```typescript
interface UpdateAuthRequest {
  auth: Record<string, any>;
  tracking_only?: boolean;
}

interface UpdateAuthResponse {
  success: boolean;
}
```

---

## 6. Delete Authentication

`POST /api/couriers/v1/{courier}/delete-auth`

Deletes a previously registered courier authentication.

```typescript
interface DeleteAuthRequest {
  auth_company?: string;
  testing?: boolean;
}

interface DeleteAuthResponse {
  success: boolean;
}
```

---

## 7. List Registered Authentications (Raw)

`GET /api/couriers/v1/auths.json`

Returns a list of all registered courier authentications including the raw database fields and a `courier_split` helper object.

The `courier_split` object breaks down the courier key into:

- `name`: The base courier name.
- `company`: The `auth_company` value.
- `test`: Whether it is a test account (`boolean`).

---

## 8. Get Courier Specifics

`GET /api/couriers/v1/{courier}/courier-specifics`

Returns the required and optional fields that can be passed in the `courier` object during shipment creation (e.g., `signature_required`, `saturday_delivery`).

```typescript
interface CourierSpecificField {
  name: string;
  type: string;
  description: string;
}

interface CourierSpecificsResponse {
  required?: CourierSpecificField[];
  optional?: CourierSpecificField[];
}
```

---

## 9. Service Presets

### Get Service Presets

`GET /api/couriers/v1/{courier}/presets`

Returns available service presets — both system-wide and your own custom presets.

### Get My Service Presets

`GET /api/couriers/v1/{courier}/my-presets`

Returns only the presets explicitly assigned to your account for this courier.

```typescript
interface ServicePreset {
  id: number;
  name: string;
  /** The dc_service_id string used in label creation requests. */
  dc_service_id: string;
  courier: string;
  transit_time_id?: number;
}

interface GetPresetsResponse {
  user_presets: ServicePreset[];
  system_presets: ServicePreset[];
}

interface GetMyPresetsResponse {
  presets: ServicePreset[];
}
```

---

## 10. Courier Utilities

### Ping Courier API

`POST /api/couriers/v1/{courier}/test`

Tests connectivity to the courier's system. No input body required.

### Test Courier Authentication

`POST /api/couriers/v1/{courier}/test-courier-auth`

Verifies that the registered credentials for a courier are valid.

```typescript
interface TestCourierAuthRequest {
  auth_company?: string;
  testing?: boolean;
}

interface TestCourierAuthResponse {
  success: boolean;
}
```

### Get Courier Token

`POST /api/couriers/v1/{courier}/get-token`

Retrieves or refreshes a temporary authentication token for couriers that use OAuth (e.g., Amazon Shipping, UPSv2).

```typescript
interface GetCourierTokenRequest {
  auth_company?: string;
  testing?: boolean;
}

interface CourierTokenResponse {
  /** The authentication token. */
  token: string;
  /** ISO 8601 expiry date/time of the token. */
  expiry: string;
}
```

---

## 11. Business Day Calculator

`POST /api/couriers/v1/test-date`

Calculates the next business day for a specific courier based on a given date and cutoff time.

```typescript
interface TestDateRequest {
  /** The starting date in Y-m-d format (e.g., "2024-10-27"). */
  date: string;
  /** The cutoff time in HH:MM format (e.g., "16:45"). */
  cutoff: string;
}

interface TestDateResponse {
  success: boolean;
  /** The calculated next business date in Y-m-d format. */
  date: string;
}
```

---

## 12. Custom Courier Function

`POST /api/couriers/v1/{courier}/{custom}`

Executes a courier-specific custom function. The `{custom}` URL segment is converted to camelCase to find the corresponding method on the courier class (e.g., `get-time-slots` calls `getTimeSlots`).

The input and output schema are fully dynamic and depend on the specific courier and function.
