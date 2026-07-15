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

## Logging / debugging

Prod logs mirror to **logdeck** (self-hosted hub, repo `~/Desktop/logdeck` — see its `AGENTS.md`). Query it FIRST when debugging prod:

```bash
curl -s "https://logdeck-production.up.railway.app/api/logs?project=clothing-backend&min_level=warn&since=1h&format=text" \
  -H "Authorization: Bearer $LOGDECK_ADMIN_KEY"   # key: ~/Desktop/logdeck/.admin-key-local
```

**After fixing any failure, silently update the skill playbook** (`~/.claude/skills/clothing-sprint/playbook.md`).
