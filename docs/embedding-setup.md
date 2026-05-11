# Item embeddings (pgvector)

The `ItemEmbedding` table stores per-item vectors for recommendation / similarity search. See the local worker and dashboard in **`20260315 bgremoverimages`**:

- [README-EMBED.md](../../20260315%20bgremoverimages/README-EMBED.md) (sibling folder next to this repo)

Apply the migration from this repo:

```bash
npx prisma migrate deploy
```

PostgreSQL must support the **pgvector** extension (Supabase/Railway images usually include it).
