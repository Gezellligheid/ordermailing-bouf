import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { adminAuth, db } from "../firebase-admin";
import { FieldValue } from "firebase-admin/firestore";

const inventory = new Hono();

inventory.use("*", async (c, next) => {
  const authorization = c.req.header("Authorization");
  if (!authorization?.startsWith("Bearer ")) {
    throw new HTTPException(401, { message: "Missing or invalid Authorization header" });
  }
  try {
    const idToken = authorization.slice(7);
    const decoded = await adminAuth.verifyIdToken(idToken);
    c.set("uid", decoded.uid);
  } catch {
    throw new HTTPException(401, { message: "Invalid or expired token" });
  }
  return next();
});

// POST /api/inventory/scrape-price — must be before /:id
inventory.post("/scrape-price", async (c) => {
  const { url } = await c.req.json<{ url: string }>();
  if (!url) throw new HTTPException(400, { message: "url is required" });
  try {
    const { load } = await import("cheerio");
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return c.json({ price: null, raw: null, error: `HTTP ${res.status}` });
    const html = await res.text();
    const $ = load(html);

    const selectors = [
      '[itemprop="price"]',
      'meta[itemprop="price"]',
      '[class*="price--current"]',
      '[class*="current-price"]',
      '[class*="sale-price"]',
      '[class*="product-price"]',
      ".price",
      '[data-price]',
      '[class*="price"]',
    ];

    let rawPrice: string | null = null;
    for (const sel of selectors) {
      const el = $(sel).first();
      if (!el.length) continue;
      rawPrice =
        el.attr("content") ??
        el.attr("data-price") ??
        el.attr("data-product-price") ??
        el.text().trim() ??
        null;
      if (rawPrice) break;
    }

    if (!rawPrice) return c.json({ price: null, raw: null });

    const cleaned = rawPrice.replace(/[^\d,\.]/g, "").replace(",", ".");
    const price = parseFloat(cleaned);
    return c.json({ price: isNaN(price) ? null : price, raw: rawPrice });
  } catch (err: any) {
    return c.json({ price: null, raw: null, error: err.message });
  }
});

// POST /api/inventory/parse-delivery — must be before /:id
inventory.post("/parse-delivery", async (c) => {
  const formData = await c.req.formData();
  const file = formData.get("file") as File | null;
  if (!file) throw new HTTPException(400, { message: "file is required" });

  const ext = file.name.split(".").pop()?.toLowerCase();
  const buf = Buffer.from(await file.arrayBuffer());

  if (ext === "pdf") {
    try {
      const pdfParse = (await import("pdf-parse")).default;
      const data = await pdfParse(buf);
      const lines = data.text.split("\n").map((l) => l.trim()).filter(Boolean);

      // Each line becomes a row; split on 2+ spaces or tab to separate columns
      const rows = lines.map((line) => line.split(/\s{2,}|\t/).map((cell) => cell.trim()));

      // Try to find a header row: first row with more than one non-empty column
      const headerIdx = rows.findIndex((r) => r.filter(Boolean).length > 1);
      if (headerIdx === -1) {
        // Fallback: single-column with the raw text
        return c.json({ headers: ["Tekst"], rows: lines.map((l) => [l]) });
      }

      const headers = rows[headerIdx].map((h, i) => h || `Kolom ${i + 1}`);
      const dataRows = rows.slice(headerIdx + 1).filter((r) => r.some(Boolean));
      return c.json({ headers, rows: dataRows });
    } catch (err: any) {
      throw new HTTPException(400, { message: `Kon PDF niet lezen: ${err.message}` });
    }
  }

  try {
    const XLSX = await import("xlsx");
    let workbook: ReturnType<typeof XLSX.read>;
    if (ext === "csv") {
      const text = buf.toString("utf-8");
      workbook = XLSX.read(text, { type: "string" });
    } else {
      workbook = XLSX.read(buf, { type: "buffer" });
    }

    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows: string[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" }) as string[][];
    const headers = (rows[0] ?? []).map((h) => String(h));
    const data = rows.slice(1).map((row) => row.map((cell) => String(cell)));

    return c.json({ headers, rows: data });
  } catch (err: any) {
    throw new HTTPException(400, { message: `Could not parse file: ${err.message}` });
  }
});

// GET /api/inventory
inventory.get("/", async (c) => {
  const snapshot = await db.collection("inventory_counts").orderBy("year", "desc").get();
  const list = snapshot.docs.map((doc) => {
    const data = doc.data();
    const items: any[] = data.items ?? [];
    const totalValue = items.reduce((sum: number, item: any) => sum + (item.totalValue ?? 0), 0);
    const countedProducts = items.filter((i: any) => (i.quantity ?? 0) > 0).length;
    return {
      id: doc.id,
      year: data.year,
      label: data.label,
      status: data.status,
      startedAt: data.startedAt,
      closedAt: data.closedAt ?? null,
      createdBy: data.createdBy,
      totalItems: items.length,
      countedProducts,
      totalValue,
    };
  });
  return c.json(list);
});

// POST /api/inventory
inventory.post("/", async (c) => {
  const { year, label } = await c.req.json<{ year: number; label?: string }>();
  if (!year) throw new HTTPException(400, { message: "year is required" });

  const existing = await db.collection("inventory_counts").where("year", "==", year).get();
  if (!existing.empty) {
    throw new HTTPException(400, { message: `Een inventaris voor ${year} bestaat al` });
  }

  const suppliersSnap = await db.collection("suppliers").orderBy("name").get();
  const items: any[] = [];

  for (const supplierDoc of suppliersSnap.docs) {
    const s = supplierDoc.data();
    if (!s.isActive) continue;
    const productsSnap = await db
      .collection("suppliers")
      .doc(supplierDoc.id)
      .collection("products")
      .orderBy("displayOrder")
      .get();
    for (const productDoc of productsSnap.docs) {
      const p = productDoc.data();
      if (!p.isActive) continue;
      items.push({
        productId: productDoc.id,
        supplierId: supplierDoc.id,
        supplierCompanyName: s.name,
        internalName: p.internalName,
        supplierProductName: p.supplierName,
        quantity: 0,
        priceAtCount: p.price ?? 0,
        priceUnit: p.priceUnit ?? "stuk",
        totalValue: 0,
      });
    }
  }

  const ref = await db.collection("inventory_counts").add({
    year,
    label: label ?? `Inventaris ${year}`,
    status: "open",
    startedAt: new Date().toISOString(),
    createdBy: c.get("uid"),
    items,
  });

  return c.json({ id: ref.id, year, label: label ?? `Inventaris ${year}`, status: "open", totalItems: items.length }, 201);
});

// GET /api/inventory/:id
inventory.get("/:id", async (c) => {
  const id = c.req.param("id");
  const doc = await db.collection("inventory_counts").doc(id).get();
  if (!doc.exists) throw new HTTPException(404, { message: "Not found" });
  return c.json({ id: doc.id, ...doc.data() });
});

// PATCH /api/inventory/:id
inventory.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ status?: "open" | "closed"; label?: string }>();
  const update: Record<string, unknown> = {};
  if (body.status !== undefined) {
    update.status = body.status;
    if (body.status === "closed") update.closedAt = new Date().toISOString();
  }
  if (body.label !== undefined) update.label = body.label;
  await db.collection("inventory_counts").doc(id).update(update);
  return c.json({ ok: true });
});

// PUT /api/inventory/:id/items
inventory.put("/:id/items", async (c) => {
  const id = c.req.param("id");
  const { items } = await c.req.json<{ items: any[] }>();
  const enriched = items.map((item) => ({
    ...item,
    totalValue: (item.quantity ?? 0) * (item.priceAtCount ?? 0),
  }));
  await db.collection("inventory_counts").doc(id).update({ items: enriched });
  return c.json({ ok: true });
});

// DELETE /api/inventory/:id
inventory.delete("/:id", async (c) => {
  const id = c.req.param("id");
  await db.collection("inventory_counts").doc(id).delete();
  return c.json({ ok: true });
});

export { inventory as inventoryRouter };
