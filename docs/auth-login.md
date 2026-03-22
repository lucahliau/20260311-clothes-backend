# `POST /auth/login` contract and troubleshooting

## Expected request (this repo)

There is **no mobile/web client** in this repository; callers are external (e.g. iOS app).

The server expects **one** of:

1. **JSON** — `Content-Type: application/json`  
   Body: `{ "email": "user@example.com", "password": "secret" }`  
   Top-level keys **`email`** and **`password`** are required strings.

2. **Form URL-encoded** — `Content-Type: application/x-www-form-urlencoded`  
   Same fields: `email` and `password`.

## Why you see `email: ["Invalid input: expected string, received undefined"]`

Zod validates the parsed body. That message means **`email` was missing** on the object after parsing, typically because:

- The body was **empty** (`{}`) — often when `Content-Type` is not JSON or urlencoded, so Express does not populate `req.body`.
- The client sends a **different shape** (e.g. nested under `user` or `credentials`) without top-level `email`.
- The client sends **`username`** instead of `email` (unless it looks like an email address; see backward compatibility below).

## Recent backend changes (diagnosis)

- **`e94a5a5` — Improve error handling**  
  Centralized `ZodError` → HTTP **400** with `code: "VALIDATION_ERROR"` and `details` = `fieldErrors`.  
  Failures are **more visible** and consistent; the login **contract** (top-level `email` / `password`) did not change here.

- **`ebd9dc0` — Update auth routes**  
  Introduced `req.body ?? {}` and `toAuthUser()` for responses.  
  Empty or unparsed bodies become `{}`, so validation fails with **missing `email`** instead of a less clear error.

So a sudden spike in this error is often **client or proxy drift** (headers/body shape), not a silent server bug in the login query itself.

## Backward compatibility (server)

The API may accept:

- `{ "user": { "email": "...", "password": "..." } }` (normalized to top-level `email` / `password`).
- `{ "credentials": { "email": "...", "password": "..." } }` (same).
- `{ "username": "x@y.com", "password": "..." }` when `username` contains `@` (treated as `email`).

Always prefer the flat JSON shape above for new clients.
