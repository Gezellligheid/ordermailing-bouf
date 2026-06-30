import { sentryServerConfig } from "./sentry.server.config";
import { apply, serve } from "@photonjs/hono";
import { Hono } from "hono";
import * as Sentry from "@sentry/node";
import { usersRouter } from "./api/users";
import { suppliersRouter } from "./api/suppliers";
import { ordersRouter } from "./api/orders";
import { designsRouter } from "./api/designs";
import { inventoryRouter } from "./api/inventory";

sentryServerConfig();

// Ping Supabase every 5 days to prevent free-tier project pause (threshold: 7 days)
const FIVE_DAYS_MS = 5 * 24 * 60 * 60 * 1000;
setInterval(async () => {
  try {
    const { createClient } = await import("@supabase/supabase-js");
    const client = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { persistSession: false },
    });
    await client.from("_supabase_keep_alive").select("1").limit(1).maybeSingle();
  } catch {
    // silently ignore — this is best-effort
  }
}, FIVE_DAYS_MS);

const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

export default startApp() as unknown;

function startApp() {
  const app = new Hono();

  app.get("/api/sentry-test", (c) => {
    try {
      throw new Error("Test backend Sentry error");
    } catch (err) {
      Sentry.captureException(err);
      return c.json({ ok: false, error: "Backend error captured by Sentry" }, 500);
    }
  });

  app.route("/api/users", usersRouter);
  app.route("/api/suppliers", suppliersRouter);
  app.route("/api/orders", ordersRouter);
  app.route("/api/designs", designsRouter);
  app.route("/api/inventory", inventoryRouter);

  apply(app, []);

  return serve(app, {
    port,
  });
}
