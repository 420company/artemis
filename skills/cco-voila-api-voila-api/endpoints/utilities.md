# Miscellaneous Utilities Endpoints

Various tools and features.

---

## 1. Hosted Pages

Redirect your end-users to a secure, Voila-hosted environment to perform actions like registering courier credentials without exposing your API credentials.

### Create Hosted Page
`POST /api/hosted-pages/create/{page}`

**URL Parameter:** `page` — Currently supported value: `register-couriers`.

```typescript
interface CreateHostedPageResponse {
  /** The unique, temporary URL to be presented to the end user. */
  url: string;
}
```

---

## 2. PackEye Integration

PackEye is an integrated camera solution for packing stations.

### Get PackEye S3 Link
`GET /api/packeye/s3link`

Retrieves a temporary, authenticated Amazon S3 URL for a recorded packing session video.

**Query Parameters:**
- `key` (required, string): The unique file key for the video (usually from a shipment's metadata).

```typescript
interface PackEyeS3LinkResponse {
  /** The original file key. */
  key: string;
  /** The temporary, authenticated URI to access the video. */
  uri: string;
}
```

---

## 3. Insurance Plugins

### List Insurance Plugins
`GET /api/plugins/list-insurance-plugins`

Returns a list of insurance plugins (e.g., Anansi) that are enabled for your account and can be used during shipment creation via the `plugin_use_anansi` flag.

```typescript
interface InsurancePlugin {
  id: number;
  name: string;
  description: string;
}

type ListInsurancePluginsResponse = InsurancePlugin[];
```

---

## 4. Custom Courier Function

`POST /api/couriers/v1/{courier}/{custom}`

Executes a courier-specific custom function. The `{custom}` URL segment is converted to camelCase to find the corresponding method on the courier class (e.g., `get-time-slots` calls `getTimeSlots`).

The input and output schema are fully dynamic and depend on the specific courier and function. Contact Voila support for details on supported custom actions for a given courier.
