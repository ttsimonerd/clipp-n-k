import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import { db, clipsTable, usersTable } from "@workspace/db";
import { getSiteSettings } from "../lib/site-settings";

const router: IRouter = Router();

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Server-rendered share page with per-request Open Graph tags so Discord
// (and other link-unfurlers) can embed the clip preview. A pure client-side
// SPA can't do this for statically-hosted production builds.
router.get("/:slug", async (req, res): Promise<void> => {
  const slug = Array.isArray(req.params.slug) ? req.params.slug[0] : req.params.slug;

  const [row] = await db
    .select({ clip: clipsTable, ownerUsername: usersTable.username })
    .from(clipsTable)
    .innerJoin(usersTable, eq(clipsTable.ownerId, usersTable.id))
    .where(
      and(
        eq(clipsTable.slug, slug as string),
        eq(clipsTable.visibility, "public"),
        eq(usersTable.banned, false),
      ),
    );

  if (!row) {
    res.status(404).send("Clip not found or not public.");
    return;
  }

  const settings = await getSiteSettings();
  const brandTitle = escapeHtml(settings.brandingTitle);
  const origin = `${req.protocol}://${req.get("host")}`;
  const pageUrl = `${origin}/c/${row.clip.slug}`;
  const title = escapeHtml(row.clip.title);
  const description = escapeHtml(`Clipped by ${row.ownerUsername} on ${settings.brandingTitle}`);
  // mimeType is client-supplied at upload time (spoofable) and must be
  // escaped here — previously it was injected raw into the og:video:type
  // attribute, which allowed stored XSS via a crafted Content-Type header.
  const mimeType = escapeHtml(row.clip.mimeType);
  const brandColor = settings.brandingPrimaryColor;
  const logoUrl = settings.brandingLogoUrl ? escapeHtml(settings.brandingLogoUrl) : undefined;
  const isReady = row.clip.status === "ready";
  const videoUrl = `${origin}/api/public/clips/${row.clip.slug}/video`;
  const thumbnailUrl = row.clip.thumbnailKey
    ? `${origin}/api/public/clips/${row.clip.slug}/thumbnail`
    : undefined;

  // Public clip data is safe to cache briefly; visibility/status are
  // re-checked on every request, and a 60s TTL keeps stale unfurls bounded
  // after a clip is flipped back to private.
  res.set("Cache-Control", "public, max-age=60, s-maxage=60");
  res.set("Content-Type", "text/html; charset=utf-8");
  res.send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${title} - ${brandTitle}</title>
<meta name="description" content="${description}" />
<meta property="og:type" content="${isReady ? "video.other" : "website"}" />
<meta property="og:title" content="${title}" />
<meta property="og:description" content="${description}" />
<meta property="og:url" content="${pageUrl}" />
${isReady && thumbnailUrl ? `<meta property="og:image" content="${thumbnailUrl}" />` : ""}
${isReady ? `<meta property="og:video" content="${videoUrl}" />
<meta property="og:video:type" content="${mimeType}" />
${row.clip.width ? `<meta property="og:video:width" content="${row.clip.width}" />` : ""}
${row.clip.height ? `<meta property="og:video:height" content="${row.clip.height}" />` : ""}
<meta name="twitter:card" content="player" />
<meta name="twitter:title" content="${title}" />
<meta name="twitter:player:stream" content="${videoUrl}" />` : ""}
<style>
  :root { --brand: ${brandColor}; }
  body { margin: 0; background: #0b0d12; color: #f4f4f5; font-family: system-ui, sans-serif; display: flex; flex-direction: column; align-items: center; min-height: 100vh; justify-content: center; gap: 16px; }
  video { max-width: 90vw; max-height: 80vh; border-radius: 12px; }
  h1 { font-size: 1.1rem; font-weight: 600; margin: 0; }
  p { margin: 0; opacity: 0.7; font-size: 0.9rem; }
  .brand { width: 8px; height: 8px; border-radius: 999px; background: var(--brand); display: inline-block; margin-right: 6px; }
  .badge { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.08em; opacity: 0.8; font-weight: 700; }
</style>
</head>
<body>
  ${isReady
    ? `<video src="${videoUrl}" poster="${thumbnailUrl ?? ""}" controls autoplay muted loop playsinline></video>`
    : `<div class="badge"><span class="brand"></span>${row.clip.status === "processing" ? "Still processing" : "Unavailable"}</div>`}
  <h1>${title}</h1>
  <p>${description}</p>
  ${logoUrl ? `<img src="${logoUrl}" alt="" style="max-height: 32px; opacity: 0.8;" />` : ""}
</body>
</html>`);
});

export default router;
