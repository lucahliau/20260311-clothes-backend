import { Router, Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { withCdnImages } from "../lib/imageCdn.js";
import { requireAuth } from "../middleware/auth.js";
import { AppError } from "../middleware/error.js";

const router = Router();

router.use(requireAuth);

const createCollectionSchema = z.object({
  name: z.string().min(1).max(100),
});

const updateCollectionSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    coverUrl: z.string().url().nullable().optional(),
  })
  .strict();

const addItemSchema = z.object({
  itemId: z.string().uuid(),
});

/** Safety ceiling on items returned with a collection — collections are
 * user-curated and small in practice; this only guards the pathological case. */
const MAX_COLLECTION_ITEMS = 2000;

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
  const { name } = createCollectionSchema.parse(req.body);

  const collection = await prisma.collection.create({
    data: {
      userId: req.user!.userId,
      name,
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
        take: MAX_COLLECTION_ITEMS,
      },
    },
  });

  if (!collection || collection.userId !== req.user!.userId) {
    throw new AppError(404, "NOT_FOUND", "Collection not found");
  }

  res.json({
    ...collection,
    items: collection.items.map((ci) => ({ ...ci, item: withCdnImages(ci.item) })),
  });
});

// ---------------------------------------------------------------------------
// PATCH /collections/:id
// ---------------------------------------------------------------------------

router.patch("/:id", async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const data = updateCollectionSchema.parse(req.body);

  if (Object.keys(data).length === 0) {
    throw new AppError(400, "BAD_REQUEST", "No fields to update");
  }

  const existing = await prisma.collection.findUnique({ where: { id } });
  if (!existing || existing.userId !== req.user!.userId) {
    throw new AppError(404, "NOT_FOUND", "Collection not found");
  }

  const collection = await prisma.collection.update({
    where: { id },
    data,
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
    throw new AppError(404, "NOT_FOUND", "Collection not found");
  }

  await prisma.collection.delete({ where: { id } });

  res.json({ message: "Collection deleted" });
});

// ---------------------------------------------------------------------------
// POST /collections/:id/items
// ---------------------------------------------------------------------------

router.post("/:id/items", async (req: Request, res: Response) => {
  const collectionId = req.params.id as string;
  const { itemId } = addItemSchema.parse(req.body);

  const collection = await prisma.collection.findUnique({ where: { id: collectionId } });
  if (!collection || collection.userId !== req.user!.userId) {
    throw new AppError(404, "NOT_FOUND", "Collection not found");
  }

  const item = await prisma.clothingItem.findUnique({ where: { id: itemId, active: true } });
  if (!item) {
    throw new AppError(404, "NOT_FOUND", "Item not found");
  }

  const existing = await prisma.collectionItem.findUnique({
    where: { collectionId_itemId: { collectionId, itemId } },
  });
  if (existing) {
    throw new AppError(409, "CONFLICT", "Item is already in this collection");
  }

  const collectionItem = await prisma.collectionItem.create({
    data: { collectionId, itemId },
    include: { item: true },
  });

  res.status(201).json({ ...collectionItem, item: withCdnImages(collectionItem.item) });
});

// ---------------------------------------------------------------------------
// DELETE /collections/:id/items/:itemId
// ---------------------------------------------------------------------------

router.delete("/:id/items/:itemId", async (req: Request, res: Response) => {
  const collectionId = req.params.id as string;
  const itemId = req.params.itemId as string;

  const collection = await prisma.collection.findUnique({ where: { id: collectionId } });
  if (!collection || collection.userId !== req.user!.userId) {
    throw new AppError(404, "NOT_FOUND", "Collection not found");
  }

  const collectionItem = await prisma.collectionItem.findUnique({
    where: { collectionId_itemId: { collectionId, itemId } },
  });
  if (!collectionItem) {
    throw new AppError(404, "NOT_FOUND", "Item not in this collection");
  }

  await prisma.collectionItem.delete({
    where: { id: collectionItem.id },
  });

  res.json({ message: "Item removed from collection" });
});

export default router;
