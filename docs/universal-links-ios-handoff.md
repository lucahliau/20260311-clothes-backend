# Universal Links + password reset — iOS / frontend handoff

## Production API base URL (use this, not localhost)

Point **all** HTTP clients (including forgot-password and login) at the deployed origin:

`https://20260311-clothes-backend-production.up.railway.app`

Example endpoints:

- `POST .../auth/forgot-password`
- `POST .../auth/reset-password`
- `GET .../.well-known/apple-app-site-association`

Do **not** use `http://localhost:3000` in release builds; that targets a dev server on the device/simulator host, not Railway.

## Backend (already implemented)

- `GET /.well-known/apple-app-site-association` — JSON for Apple; returns **404** until `APPLE_UNIVERSAL_LINK_APP_ID` is set **or** both `APNS_TEAM_ID` and `APNS_BUNDLE_ID` are set (combined as `TeamID.bundleId`).
- `GET /reset-password` — minimal HTML fallback when the link opens in Safari (no app or Universal Links not active yet).
- `POST /auth/forgot-password` — body `{ "email": "..." }`; email contains `APP_URL/reset-password?token=...`.
- `POST /auth/reset-password` — body `{ "token": "...", "password": "..." }` (password 8–128 chars).

## Railway env

Set on the service that runs this API:

| Variable | Example | Notes |
|----------|---------|--------|
| `APP_URL` | `https://20260311-clothes-backend-production.up.railway.app` | No trailing slash; must match the public HTTPS origin of this server. |
| `APPLE_UNIVERSAL_LINK_APP_ID` | `ABCDE12345.com.your.bundle` | Optional if you use the two APNS vars below instead. |
| `APNS_TEAM_ID` + `APNS_BUNDLE_ID` | | Optional fallback to build app ID for AASA. |

After deploy, verify: `https://<host>/.well-known/apple-app-site-association` returns JSON (not 404).

## Xcode / iOS app

1. **Associated Domains** capability: add  
   `applinks:<your-railway-host>`  
   Example: `applinks:20260311-clothes-backend-production.up.railway.app` (no `https://`).

2. **appID** in AASA must equal `TeamID.bundleIdentifier` for your app — match what you set in Railway (`APPLE_UNIVERSAL_LINK_APP_ID` or `APNS_TEAM_ID` + `APNS_BUNDLE_ID`).

3. **Handle the link** when the user taps the email link:
   - Universal Link URL: `https://<same-host-as-APP_URL>/reset-password?token=<token>`
   - Parse query parameter `token`.
   - Show reset-password UI, then:  
     `POST https://<same-host>/auth/reset-password`  
     with JSON `{ "token": "<token>", "password": "<new password>" }`.

4. Use the same API base URL your backend is deployed on for all `/auth/*` calls.
