# Railway production environment

Set these on the Railway service (Variables). Redeploy after changes if the platform does not auto-redeploy.

## Required for API + password reset emails

| Variable             | Example                                                      | Notes                                                                                                                                      |
| -------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `APP_URL`            | `https://20260311-clothes-backend-production.up.railway.app` | Public HTTPS origin of **this** service. No trailing slash. Used in forgot-password email links and must match Universal Links host.       |
| `NODE_ENV`           | `production`                                                 | Enables production CORS behavior and trust proxy when set.                                                                                 |
| `DATABASE_URL`       | (from Supabase or Postgres)                                  |                                                                                                                                            |
| `JWT_SECRET`         | (long random string)                                         |                                                                                                                                            |
| `JWT_REFRESH_SECRET` | (long random string)                                         |                                                                                                                                            |
| `RESEND_API_KEY`     | `re_...`                                                     | Required for sending email.                                                                                                                |
| `RESEND_FROM_EMAIL`  | `onboarding@resend.dev` or `Name <noreply@yourdomain.com>`   | Defaults to `onboarding@resend.dev` (Resend test sender). For production, use an address on a **verified domain** in the Resend dashboard. |

Optional shared-database protection: `DB_HEAVY_REQUEST_CONCURRENCY` defaults to `4`;
`DB_READY_MAX_LATENCY_MS` defaults to `2500`; `DB_STATEMENT_TIMEOUT_MS` defaults to `8000`;
`DB_QUERY_TIMEOUT_MS` defaults to `10000`.

If Resend rejects the send (invalid `from`, unverified domain, etc.), `POST /auth/forgot-password` returns **503** with `EMAIL_SEND_FAILED` instead of a silent 200.

## Universal Links (AASA)

| Variable                          | Notes                                  |
| --------------------------------- | -------------------------------------- |
| `APPLE_UNIVERSAL_LINK_APP_ID`     | `TeamID.bundleIdentifier`, **or**      |
| `APNS_TEAM_ID` + `APNS_BUNDLE_ID` | Combined as `TeamID.bundleId` for AASA |

## CORS (if a browser calls this API)

| Variable      | Example                                            |
| ------------- | -------------------------------------------------- |
| `CORS_ORIGIN` | `https://your-web-app.com` or comma-separated list |

Native iOS apps using `URLSession` typically do not need CORS.

## Deploy gating (Wait for CI)

Railway deploys every push to `main` immediately — even if GitHub Actions is red. Enable check-suite gating so broken builds never ship:

Railway dashboard → this service → **Settings → Deploy → Wait for CI**. Railway then holds the build until the commit's GitHub check suite passes.

## Trust proxy (Railway)

Railway sits behind a reverse proxy. The app sets `trust proxy` when `NODE_ENV=production` or `TRUST_PROXY=1`.

## Verify after deploy

- `GET https://<your-host>/health`
- `GET https://<your-host>/.well-known/apple-app-site-association` (JSON if app ID env is set)
- `GET https://<your-host>/reset-password` (HTML)

## Local development (optional)

If you run the API with `npm run dev` but want **password-reset emails** to use the same links as production (Railway host + Universal Links), set in your local `.env`:

`APP_URL=https://20260311-clothes-backend-production.up.railway.app`

See [`.env.example`](../.env.example) for a commented template. Keep `http://localhost:3000` only if reset links should stay local.
