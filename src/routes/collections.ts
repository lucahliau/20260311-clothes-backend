import { Router, Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

router.use(requireAuth);

const createCollectionSchema = z.object({
  name: z.string().min(1).max(100),
});

const updateCollectionSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  coverUrl: z.string().url().nullable().optional(),
}).strict();

const addItemSchema = z.object({
  itemId: z.string().uuid(),
});

// ---------------------------------------------------------------------------
// GET /collections
// ---------------------------------------------------------------------------

router.get("/", async (req: Request, res: Response) => {
  const collections = await prisma.collection.findMany({
    where: { userId: req.user!.userId },
    include: {
      _count: { select: { items: true } },
    },
    orderBy: { updatedAt: "desc" },
  });

  res.json(collections);
});

// ---------------------------------------------------------------------------
// POST /collections
// ---------------------------------------------------------------------------

router.post("/", async (req: Request, res: Response) => {
  const parsed = createCollectionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.flatten().fieldErrors });
    return;
  }

  const collection = await prisma.collection.create({
    data: {
      userId: req.user!.userId,
      name: parsed.data.name,
    },
  });

  res.status(201).json(collection);
});

// ---------------------------------------------------------------------------
// GET /collections/:id
// ---------------------------------------------------------------------------

router.get("/:id", async (req: Request, res: Response) => {
  const id = req.params.id as string;

  const collection = await prisma.collection.findUnique({
    where: { id },
    include: {
      items: {
        include: { item: true },
        orderBy: { addedAt: "desc" },
      },
    },
  });

  if (!collection || collection.userId !== req.user!.userId) {
    res.status(404).json({ error: "Collection not found" });
    return;
  }

  res.json(collection);
});

// ---------------------------------------------------------------------------
// PATCH /collections/:id
// ---------------------------------------------------------------------------

router.patch("/:id", async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const parsed = updateCollectionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.flatten().fieldErrors });
    return;
  }

  if (Object.keys(parsed.data).length === 0) {
    res.status(400).json({ error: "No fields to update" });
    return;
  }

  const existing = await prisma.collection.findUnique({ where: { id } });
  if (!existing || existing.userId !== req.user!.userId) {
    res.status(404).json({ error: "Collection not found" });
    return;
  }

  const collection = await prisma.collection.update({
    where: { id },
    data: parsed.data,
  });

  res.json(collection);
});

// ---------------------------------------------------------------------------
// DELETE /collections/:id
// ---------------------------------------------------------------------------

router.delete("/:id", async (req: Request, res: Response) => {
  const id = req.params.id as string;

  const existing = await prisma.collection.findUnique({ where: { id } });
  if (!existing || existing.userId !== req.user!.userId) {
    res.status(404).json({ error: "Collection not found" });
    return;
  }

  await prisma.collection.delete({ where: { id } });

  res.json({ message: "Collection deleted" });
});

// ---------------------------------------------------------------------------
// POST /collections/:id/items
// ---------------------------------------------------------------------------

router.post("/:id/items", async (req: Request, res: Response) => {
  const collectionId = req.params.id as string;
  const parsed = addItemSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.flatten().fieldErrors });
    return;
  }

  const collection = await prisma.collection.findUnique({ where: { id: collectionId } });
  if (!collection || collection.userId !== req.user!.userId) {
    res.status(404).json({ error: "Collection not found" });
    return;
  }

  const item = await prisma.clothingItem.findUnique({ where: { id: parsed.data.itemId, active: true } });
  if (!item) {
    res.status(404).json({ error: "Item not found" });
    return;
  }

  const existing = await prisma.collectionItem.findUnique({
    where: { collectionId_itemId: { collectionId, itemId: parsed.data.itemId } },
  });
  if (existing) {
    res.status(409).json({ error: "Item is already in this collection" });
    return;
  }

  const collectionItem = await prisma.collectionItem.create({
    data: { collectionId, itemId: parsed.data.itemId },
    include: { item: true },
  });

  res.status(201).json(collectionItem);
});

// ---------------------------------------------------------------------------
// DELETE /collections/:id/items/:itemId
// ---------------------------------------------------------------------------

router.delete("/:id/items/:itemId", async (req: Request, res: Response) => {
  const collectionId = req.params.id as string;
  const itemId = req.params.itemId as string;

  const collection = await prisma.collection.findUnique({ where: { id: collectionId } });
  if (!collection || collection.userId !== req.user!.userId) {
    res.status(404).json({ error: "Collection not found" });
    return;
  }

  const collectionItem = await prisma.collectionItem.findUnique({
    where: { collectionId_itemId: { collectionId, itemId } },
  });
  if (!collectionItem) {
    res.status(404).json({ error: "Item not in this collection" });
    return;
  }

  await prisma.collectionItem.delete({
    where: { id: collectionItem.id },
  });

  res.json({ message: "Item removed from collection" });
});

export default router;
