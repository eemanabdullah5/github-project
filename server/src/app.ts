// Builds the Express app. Route handlers stay thin: read inputs, call a module,
// send the result. Kept separate from index.ts so tests can start the app on any port.
import express, { type NextFunction, type Request, type Response } from "express";
import { AppError } from "./errors.js";

export function createApp() {
  const app = express();
  app.use(express.json());

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.use(errorHandler);
  return app;
}

// Express recognises an error handler by its four parameters.
function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  // Log only the message: never the request, headers or config, which could hold the token.
  console.error("Unexpected error:", err instanceof Error ? err.message : err);
  res.status(500).json({ error: "Something went wrong on the server. Please try again." });
}
