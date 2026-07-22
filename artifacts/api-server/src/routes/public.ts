import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import { db, clipsTable, usersTable } from "@workspace/db";
import { GetPublicClipResponse } from "@workspace/api-zod";
import { getStorageDriver } from "../lib/storage";

const router: IRouter = Router();

async function loadPublicClip(slugParam: unknown) {
  const slug = Array.isArray(slugParam) ? slugParam[0] : slugParam;
  const [row] = await db
    .select({ clip: clipsTable, ownerUsername: usersTable.username })
    .from(clipsTable)
    .innerJoin(usersTable, eq(clipsTable.ownerId, usersTable.id))
    .where(and(eq(clipsTable.slug, slug as string), eq(clipsTable.visibility, "public")));
  return row;
}

router.get("/public/clips/:slug", async (req, res): Promise<void> => {
  const row = await loadPublicClip(req.params.slug);

  if (!row) {
    res.status(404).json({ error: "Clip not found" });
    return;
  }

  const origin = `${req.protocol}://${req.get("host")}`;
  const data = GetPublicClipResponse.parse({
    slug: row.clip.slug,
    title: row.clip.title,
    videoUrl: `${origin}/api/public/clips/${row.clip.slug}/video`,
    thumbnailUrl: row.clip.thumbnailKey
      ? `${origin}/api/public/clips/${row.clip.slug}/thumbnail`
      : null,
    width: row.clip.width,
    height: row.clip.height,
    durationSeconds: row.clip.durationSeconds,
    ownerUsername: row.ownerUsername,
  });
  res.json(data);
});

// Media streaming for public clips. Visibility is re-checked on every
// request (not just when the share page/API response was generated) so a
// clip flipped back to private immediately stops being servable here --
// there is no separate unauthenticated static file route for clip media.
router.get("/public/clips/:slug/video", async (req, res): Promise<void> => {
  const row = await loadPublicClip(req.params.slug);
  if (!row || row.clip.status !== "ready") {
    res.status(404).json({ error: "Clip not found" });
    return;
  }
  const storage = getStorageDriver();
  const localPath = await storage.getLocalPath(row.clip.storageKey);
  res.sendFile(localPath, { headers: { "Content-Type": row.clip.mimeType } });
});

router.get("/public/clips/:slug/thumbnail", async (req, res): Promise<void> => {
  const row = await loadPublicClip(req.params.slug);
  if (!row || !row.clip.thumbnailKey) {
    res.status(404).json({ error: "Thumbnail not found" });
    return;
  }
  const storage = getStorageDriver();
  const localPath = await storage.getLocalPath(row.clip.thumbnailKey);
  res.sendFile(localPath, { headers: { "Content-Type": "image/jpeg" } });
});

export default router;
