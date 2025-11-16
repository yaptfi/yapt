# iOS Client Integration

This document describes how to integrate an iOS client with Yapt using passkeys and the existing session‑cookie authentication model.

The backend already exposes WebAuthn (passkey) endpoints and uses HTTP‑only session cookies. A native iOS app can reuse these as‑is.

## Requirements

- Backend configured with:
  - `RP_ID` set to your domain (e.g. `yapt.example.com`)
  - `ORIGIN` set to one or more allowed origins, comma‑separated:
    - Example: `ORIGIN=https://yapt.example.com,https://app.yapt.example.com`
- iOS app configured with:
  - Associated domains for the same `RP_ID`
  - Network access to the API host

## Auth Flow Overview

Yapt exposes these WebAuthn endpoints:

- `POST /api/auth/register/generate-options`
- `POST /api/auth/register/verify`
- `POST /api/auth/login/generate-options`
- `POST /api/auth/login/verify`
- `GET /api/auth/me`
- `POST /api/auth/logout`

After a successful registration or login verification, the server sets a session cookie. The iOS client should preserve and send this cookie on subsequent `/api/...` requests.

## Registration with Passkey (iOS)

1. **Generate options**

   - Request:

     - `POST /api/auth/register/generate-options`
     - Body: `{ "username": "<chosen username>" }`

   - Response: WebAuthn `PublicKeyCredentialCreationOptions` JSON.

2. **Create credential on iOS**

   - Use `ASAuthorizationPlatformPublicKeyCredentialProvider` with:
     - `relyingPartyIdentifier` = `RP_ID` (same as backend)
   - Construct a request using the challenge and parameters from the server’s options.
   - When the user completes passkey creation, convert the result into a WebAuthn‑compatible JSON object matching `RegistrationResponseJSON`.

3. **Verify registration**

   - Request:

     - `POST /api/auth/register/verify`
     - Body: the WebAuthn registration response JSON from step 2.

   - The request must reuse the same HTTP session (cookies) as the `generate-options` call so the server can read the stored challenge.
   - On success, the server responds with `{ verified: true, user: { ... } }` and sets the session cookie.

## Login with Passkey (iOS)

1. **Generate options**

   - Request:

     - `POST /api/auth/login/generate-options`
     - Body: `{ "username": "<existing username>" }`

   - Response: WebAuthn `PublicKeyCredentialRequestOptions` JSON.

2. **Authenticate with passkey**

   - Use `ASAuthorizationPlatformPublicKeyCredentialProvider` to create an assertion request using the challenge and parameters from the server.
   - Convert the result into a WebAuthn‑compatible JSON object matching `AuthenticationResponseJSON`.

3. **Verify authentication**

   - Request:

     - `POST /api/auth/login/verify`
     - Body: the WebAuthn authentication response JSON from step 2.

   - As with registration, reuse the same HTTP session so the stored challenge is available.
   - On success, the server responds with `{ verified: true, user: { ... } }` and sets/updates the session cookie.

## Session Handling

- The backend uses `@fastify/session` with a cookie:
  - Name: `yapt.sid`
  - Attributes: `HttpOnly`, `SameSite=Lax`, `Secure` when HTTPS is enabled.
- The iOS client should:
  - Use a shared `URLSession` (or equivalent) so cookies from auth endpoints are automatically sent with subsequent API calls.
  - Make all authenticated API requests over HTTPS to the same host used during login.

Example authenticated request:

- `GET /api/portfolio/summary`
- The session cookie set by `/api/auth/register/verify` or `/api/auth/login/verify` must be present.

## WebAuthn Origin Configuration

The backend validates WebAuthn responses using `expectedOrigin` and `expectedRPID`:

- `RP_ID` is a single value (e.g. `yapt.example.com`).
- `ORIGIN` can be one or more comma‑separated origins, for example:

  ```env
  RP_ID=yapt.example.com
  ORIGIN=https://yapt.example.com,https://app.yapt.example.com
  ```

- Internally, the service passes all configured origins to the WebAuthn verification helpers, so responses from any of these origins are accepted.

For iOS, ensure that the origin used by Apple’s WebAuthn implementation corresponds to one of the configured `ORIGIN` values.

