import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";

export default Router().post("/", validateFields({ taskId: z.uuid() }), (req, res) => {
  u.mcpControl.assertAppRequest(req);
  u.ai.cancelCodexTask(req.body.taskId);
  res.json(success(null));
});
