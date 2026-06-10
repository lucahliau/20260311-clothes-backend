# Clothing app — Backend API

This is the **Express 5 + TypeScript + Prisma backend** (Supabase Postgres, Railway-hosted) for the clothing app. Part of a 3-project system.

**Before re-scanning this folder, load context from the `clothing-sprint` skill:**

- `~/.claude/skills/clothing-sprint/reference/backend.md` — full map (API surface, data model, env, commands, gotchas)
- `~/.claude/skills/clothing-sprint/reference/architecture.md` — shared DB + how the app and crawler connect
- `~/.claude/skills/clothing-sprint/playbook.md` — **read before build/deploy/migrate** (proven commands / known failures)

Quick facts:

- Build: `npm run build` (`prisma generate` MUST precede `tsc`). Typecheck: `npm run typecheck`. Tests: `npm test`.
- **Deploy = git push** → Railway auto-deploys; `npm start` runs `prisma migrate deploy` first. Env vars live in the Railway dashboard, not the repo.
- Shares one Supabase Postgres with the crawler (`20260315 crawlerconfig`); `ClothingItem` is the crawler→backend contract.

**After fixing any failure, silently update the skill playbook** (`~/.claude/skills/clothing-sprint/playbook.md`).
