import type { Request, Response, NextFunction } from "express";
import { eq } from "drizzle-orm";
import { db, usersTable, type User } from "@workspace/db";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      currentUser?: User;
    }
  }
}

function getAdminIds(): Set<string> {
  const raw = process.env.ADMIN_DISCORD_IDS ?? "";
  return new Set(
    raw
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

export function isAdminDiscordId(discordId: string): boolean {
  return getAdminIds().has(discordId);
}

/** Loads the current user (if any) onto `req.currentUser`. Never rejects the request. */
export async function loadCurrentUser(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const userId = req.session.userId;
  if (!userId) {
    next();
    return;
  }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  if (user) {
    req.currentUser = user;
  }
  next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.currentUser) {
    res.status(401).json({ error: "Not logged in" });
    return;
  }
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.currentUser || !isAdminDiscordId(req.currentUser.discordId)) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  next();
}
