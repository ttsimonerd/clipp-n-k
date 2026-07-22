import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import githubRouter from "./github";
import clipsRouter from "./clips";
import adminRouter from "./admin";
import publicRouter from "./public";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(githubRouter);
router.use(clipsRouter);
router.use(adminRouter);
router.use(publicRouter);

export default router;
