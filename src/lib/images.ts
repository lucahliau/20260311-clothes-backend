/**
 * Derives the background-removed image URL from an original image URL.
 * Rule: Same path, but filename becomes {original-name}-nobg.png
 *
 * @param originalUrl - Original image URL (e.g. products/retailer/slug/0.jpg or full R2 URL)
 * @param r2BaseUrl - R2 public base URL (e.g. https://pub-xxx.r2.dev)
 * @returns The nobg URL, or null if the original is not an R2 products path
 */
export function getNobgUrl(originalUrl: string, r2BaseUrl: string): string | null {
  const base = r2BaseUrl.replace(/\/$/, "");

  let path: string;

  if (originalUrl.startsWith(base)) {
    path = originalUrl.slice(base.length).replace(/^\//, "");
  } else if (originalUrl.startsWith("products/")) {
    path = originalUrl;
  } else {
    return null;
  }

  if (!path.startsWith("products/")) {
    return null;
  }

  const lastSlash = path.lastIndexOf("/");
  const filename = path.slice(lastSlash + 1);
  const nameWithoutExt = filename.replace(/\.[^.]+$/, "");
  const nobgPath = path.slice(0, lastSlash + 1) + nameWithoutExt + "-nobg.png";

  return `${base}/${nobgPath}`;
}

/**
 * Checks if the background-removed image exists at the given URL.
 *
 * @param nobgUrl - Full URL to the -nobg.png file
 * @returns true if the file exists (HTTP 200), false otherwise
 */
export async function nobgExists(nobgUrl: string): Promise<boolean> {
  try {
    const res = await fetch(nobgUrl, { method: "HEAD" });
    return res.ok;
  } catch {
    return false;
  }
}
