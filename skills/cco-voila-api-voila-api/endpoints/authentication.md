# Authentication & User Management Endpoints

Manage API users and generate authentication tokens.

---

## 1. Create API User

`POST /api/apiuser/create`

Creates a new API User under your account.

```typescript
interface CreateApiUserRequest {
  /**
   * Unique name for the API user.
   * Max 50 characters.
   */
  name: string;
  /**
   * The API key for the new user. Min 8 characters.
   * If not provided, a random 8-character string will be generated.
   */
  key?: string;
  /**
   * The name of the API user group to assign this user to.
   * If not provided, the user will be assigned to a default group.
   */
  api_user_group_name?: string;
}

interface CreateApiUserResponse {
  name: string;
  /** The unencrypted key for the new API user. Store this securely. */
  key: string;
  /** The initial API token generated for this user. */
  token: string;
  api_user_id: number;
}
```

---

## 2. Create API Token

`POST /api/apiuser/create-token`

Generates a new API token for the currently authenticated API user.

```typescript
interface CreateApiTokenRequest {
  /** An optional label/name for the token. */
  name?: string;
}

interface CreateApiTokenResponse {
  /** The newly generated 16-character API token. */
  token: string;
}
```

---

## 3. Disable / Enable API User

`POST /api/apiuser/disable`

```typescript
interface DisableApiUserRequest {
  /** The numeric ID of the API user. Required if name is not provided. */
  id?: number;
  /** The name of the API user. Required if id is not provided. */
  name?: string;
  /** Whether to disable (true) or enable (false) the user. Defaults to true. */
  disabled?: boolean;
}

interface DisableApiUserResponse {
  success: boolean;
}
```

---

## 4. Delete API User

Two routes are available:
- `POST /api/apiuser/delete/{id}` — Delete by numeric ID.
- `POST /api/apiuser/delete/n/{name}` — Delete by name.

```typescript
interface DeleteApiUserResponse {
  success: boolean;
}
```

---

## 5. Courier Login URL (OAuth)

Generates a URL for the end-user to authenticate with a courier via OAuth (e.g., Amazon Shipping, UPSv2).

Two endpoints are available:
- `POST /api/couriers/v1/{courier}/login`
- `POST /api/couriers/v1/{courier}/get-encrypted-login`

```typescript
interface CourierLoginUrlRequest {
  /** The company name to associate with this courier authentication. */
  auth_company?: string;
  /** Use the courier's test environment. */
  testing?: boolean;
}

interface CourierLoginUrlResponse {
  /** The URL where the user should be redirected to complete the authentication. */
  url: string;
}
```

**OAuth Flow:**
1. Send request to Voila to get the `url`.
2. Redirect your end-user to that `url`.
3. The user logs in to the courier's site and authorizes Voila.
4. The courier redirects back to Voila, and the authentication is saved automatically.
