# Clothes backend

Express 5 + TypeScript API for the Clothedd iOS app. Prisma 7 on Supabase Postgres (the catalog is written by a separate crawler service into the same database), deployed on Railway.

## Quick start

```bash
npm ci
cp .env.example .env   # fill in DATABASE_URL + JWT secrets at minimum
npm run dev            # tsx watch, http://localhost:3000
```

## Commands

| Command                    | What it does                                                 |
| -------------------------- | ------------------------------------------------------------ |
| `npm run dev`              | Dev server with hot reload                                   |
| `npm run build`            | `prisma generate && tsc` (generate **must** precede tsc)     |
| `npm start`                | `prisma migrate deploy && node dist/...` (what Railway runs) |
| `npm test`                 | Unit tests (no DB needed; a dummy `DATABASE_URL` suffices)   |
| `npm run test:integration` | Endpoint tests against a real Postgres (see below)           |
| `npm run typecheck`        | `tsc --noEmit`                                               |
| `npm run lint` / `format`  | ESLint / Prettier                                            |

## API

Routers: `/auth`, `/users`, `/items`, `/brands`, `/swipes`, `/collections`, `/social`, `/messages`. Every router is mounted at both `/v1/<name>` (canonical) and the bare path (frozen contract for already-shipped iOS builds — do not change bare-path behavior; breaking changes ship as `/v2`). Support endpoints at root: `GET /health`, `GET /ready`, the Apple AASA file, and the reset/verify HTML fallback pages.

Errors everywhere have the shape `{ error: { code, message, details? } }`.

## Integration tests

The endpoint suite needs a throwaway Postgres **with pgvector** (migrations create vector indexes):

```bash
docker run -d --name clothes-test-db -p 54329:5432 \
  -e POSTGRES_PASSWORD=test -e POSTGRES_DB=clothes_test pgvector/pgvector:pg17
TEST_DATABASE_URL=postgresql://postgres:test@localhost:54329/clothes_test npm run test:integration
```

The suite refuses to run against anything but `TEST_DATABASE_URL` (it truncates tables between tests). CI runs it automatically against a service container.

## Deploy

Push to `main` → Railway builds and runs `npm start` (which applies committed migrations first). Env vars live in the Railway dashboard, not the repo — see [docs/railway-env.md](docs/railway-env.md), including the **Wait for CI** setting that keeps red builds from deploying.

## More docs

- [docs/auth-login.md](docs/auth-login.md) — auth flows (email/password, Apple, Google, sessions)
- [docs/railway-env.md](docs/railway-env.md) — production env + CORS + deploy gating
- [docs/embedding-setup.md](docs/embedding-setup.md) — pgvector / CLIP embeddings for the feed
- [docs/universal-links-ios-handoff.md](docs/universal-links-ios-handoff.md) — Universal Links setup
