import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import { db, clipsTable, usersTable } from "@workspace/db";

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
    .where(and(eq(clipsTable.slug, slug as string), eq(clipsTable.visibility, "public")));

  if (!row) {
    res.status(404).send("Clip not found or not public.");
    return;
  }

  const origin = `${req.protocol}://${req.get("host")}`;
  const videoUrl = `${origin}/api/public/clips/${row.clip.slug}/video`;
  const thumbnailUrl = row.clip.thumbnailKey
    ? `${origin}/api/public/clips/${row.clip.slug}/thumbnail`
    : undefined;
  const title = escapeHtml(row.clip.title);
  const description = escapeHtml(`Clipped by ${row.ownerUsername} on clipp'n'k`);
  const pageUrl = `${origin}/c/${row.clip.slug}`;

  res.set("Content-Type", "text/html; charset=utf-8");
  res.send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${title} - clipp'n'k</title>
<meta name="description" content="${description}" />
<meta property="og:type" content="video.other" />
<meta property="og:title" content="${title}" />
<meta property="og:description" content="${description}" />
<meta property="og:url" content="${pageUrl}" />
${thumbnailUrl ? `<meta property="og:image" content="${thumbnailUrl}" />` : ""}
<meta property="og:video" content="${videoUrl}" />
<meta property="og:video:type" content="${row.clip.mimeType}" />
${row.clip.width ? `<meta property="og:video:width" content="${row.clip.width}" />` : ""}
${row.clip.height ? `<meta property="og:video:height" content="${row.clip.height}" />` : ""}
<meta name="twitter:card" content="player" />
<meta name="twitter:title" content="${title}" />
<meta name="twitter:player:stream" content="${videoUrl}" />
<style>
  body { margin: 0; background: #0b0d12; color: #f4f4f5; font-family: system-ui, sans-serif; display: flex; flex-direction: column; align-items: center; min-height: 100vh; justify-content: center; gap: 16px; }
  video { max-width: 90vw; max-height: 80vh; border-radius: 12px; }
  h1 { font-size: 1.1rem; font-weight: 600; margin: 0; }
  p { margin: 0; opacity: 0.7; font-size: 0.9rem; }
</style>
</head>
<body>
  <video src="${videoUrl}" poster="${thumbnailUrl ?? ""}" controls autoplay muted loop playsinline></video>
  <h1>${title}</h1>
  <p>${description}</p>
</body>
</html>`);
});

export default router;
