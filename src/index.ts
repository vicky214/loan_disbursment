import http from "http";
import { disbursementController } from "./api/DisbursementController.js";
import { outboxRelay } from "./outbox/OutboxRelay.js";

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 5001;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "UP", timestamp: Date.now() }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/ledger/summary") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(disbursementController.getAuditSummary(), null, 2));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/v1/disbursements") {
    let bodyRaw = "";
    req.on("data", (chunk) => (bodyRaw += chunk));
    req.on("end", async () => {
      try {
        const body = JSON.parse(bodyRaw || "{}");
        const idempotencyKey = req.headers["idempotency-key"] as string | undefined;

        const response = await disbursementController.handleDisburse(idempotencyKey, body);

        res.writeHead(response.statusCode, response.headers);
        res.end(JSON.stringify(response.body, null, 2));
      } catch (err: any) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON format" }));
      }
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Endpoint not found" }));
});

server.listen(PORT, () => {
  console.log(`[FintechPipeline] Service online on http://localhost:${PORT}`);
  console.log(`[FintechPipeline] Endpoints:`);
  console.log(`  - POST /api/v1/disbursements (Headers: Idempotency-Key)`);
  console.log(`  - GET  /ledger/summary`);
  console.log(`  - GET  /health`);
});

const shutdown = (signal: string) => {
  console.log(`\n[FintechPipeline] Received ${signal}. Flushing Outbox and shutting down...`);
  outboxRelay.shutdown();
  server.close(() => {
    console.log("[FintechPipeline] Clean shutdown complete.");
    process.exit(0);
  });
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
