import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { pool } from "@workspace/db";

const router: IRouter = Router();

router.get("/healthz", async (_req, res) => {
  // Verify the database is reachable — a health check that reports "ok"
  // while Postgres is down would keep proxies/load-balancers routing
  // traffic to a broken instance.
  try {
    await pool.query("SELECT 1");
  } catch {
    res.status(503).json({ error: "Database unavailable" });
    return;
  }
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

export default router;
