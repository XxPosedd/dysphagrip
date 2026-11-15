import type { Express } from "express";

// This bridge is installed only by the Mac launcher. The Python service binds to loopback.
export function mountLocalMonitor(app: Express) {
  for (const action of ["status", "start", "stop", "mark"] as const) {
    const method = action === "status" ? "get" : "post";
    app[method](`/api/monitor/${action}`, async (req, res) => {
      try {
        const result = await fetch(`http://127.0.0.1:8770/api/monitor/${action}`, {
          method: method.toUpperCase(),
          headers: { "Content-Type": "application/json" },
          body: method === "post" ? JSON.stringify(req.body ?? {}) : undefined,
          signal: AbortSignal.timeout(action === "stop" ? 45000 : 18000),
        });
        res.status(result.status).type("json").send(await result.text());
      } catch {
        res.status(503).json({ error: "The local sensor service is unavailable. Reopen the DysphaGrip dashboard launcher." });
      }
    });
  }
}
