import { env } from "./env.js";

/**
 * Cloudflare Image Transformations rewrite.
 *
 * When IMG_CDN_HOST is set (a custom domain attached to the R2 bucket with
 * Image Transformations enabled), stored R2 image URLs are rewritten to
 *   https://<IMG_CDN_HOST>/cdn-cgi/image/<options>/<bucket-path>
 * so clients download right-sized, edge-cached images instead of full-res
 * originals. Unset = passthrough (safe to deploy before the domain exists).
 *
 * The iOS app derives `-nobg.png` variants by swapping the URL's path
 * extension; the options segment contains no dots, so that derivation still
 * works on rewritten URLs.
 */
const CDN_OPTIONS = "width=1300,quality=82,format=auto";

function isRewritableHost(hostname: string): boolean {
  if (hostname.endsWith(".r2.dev")) return true;
  const publicUrl = env().R2_PUBLIC_URL;
  if (publicUrl) {
    try {
      return hostname === new URL(publicUrl).hostname;
    } catch {
      return false;
    }
  }
  return false;
}

export function cdnImageUrl(url: string | null | undefined): string | null | undefined {
  const host = env().IMG_CDN_HOST;
  if (!host || !url) return url;
  try {
    const parsed = new URL(url);
    if (!isRewritableHost(parsed.hostname)) return url;
    const path = parsed.pathname.replace(/^\//, "");
    return `https://${host}/cdn-cgi/image/${CDN_OPTIONS}/${path}`;
  } catch {
    return url;
  }
}

/** Returns a copy of an item-shaped object with imageUrl/images rewritten. No-op when IMG_CDN_HOST is unset. */
export function withCdnImages<T extends { imageUrl?: string | null; images?: string[] }>(
  item: T,
): T {
  if (!env().IMG_CDN_HOST) return item;
  return {
    ...item,
    imageUrl: cdnImageUrl(item.imageUrl) ?? item.imageUrl,
    images: item.images?.map((u) => cdnImageUrl(u) ?? u),
  };
}
