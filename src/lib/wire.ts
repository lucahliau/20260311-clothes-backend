import type { ClothingItem } from "../../generated/prisma/client.js";
import { withCdnImages } from "./imageCdn.js";

/** Wire shape for feed items: only the fields the iOS `Item` model actually
 * reads (all its keys decode via decodeIfPresent, so dropping unused columns —
 * metadata, externalId, manufacturerCode, lastVerifiedAt, subcategory, sizes,
 * tags, active, updatedAt — is additive-safe for shipped builds and
 * cuts payload + client decode time). `hasNobg` lets the client skip requesting
 * the `-nobg.png` variant when it's known to be missing (saves a 404 round-trip
 * per card). */
export function toFeedItem(item: ClothingItem, cdnWidth?: number) {
  const slim = {
    id: item.id,
    name: item.name,
    description: item.description,
    brand: item.brand,
    category: item.category,
    price: item.price,
    currency: item.currency,
    salePrice: item.salePrice,
    compareAtPrice: item.compareAtPrice,
    imageUrl: item.imageUrl,
    images: item.images,
    colors: item.colors,
    gender: item.gender,
    productType: item.productType,
    sourceUrl: item.sourceUrl,
    retailer: item.retailer,
    createdAt: item.createdAt,
    hasNobg: item.hasNobg,
  };
  return cdnWidth === undefined ? withCdnImages(slim) : withCdnImages(slim, cdnWidth);
}
