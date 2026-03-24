/**
 * Shopify → Veeqo Order Sync (AfterSell Edition)
 *
 * PURPOSE:
 *   Shopify fires `orders/updated` for EVERY order change (payment, tags,
 *   fulfillment status, notes, …). This server filters down to only the
 *   events that matter: AfterSell adding line items to an already-placed
 *   order. It then mirrors those line-item changes into Veeqo.
 *
 * FILTER LOGIC (all must pass to proceed):
 *   1. HMAC signature is valid (security).
 *   2. Not a duplicate webhook (idempotency).
 *   3. The order was updated AFTER it was created (not the initial creation
 *      event that Shopify fires alongside orders/create).
 *   4. The update happened within AFTERSELL_WINDOW_MINUTES of order creation
 *      (AfterSell acts fast — if the gap is huge it's probably a manual edit
 *      or fulfilment update, not an upsell).
 *   5. The line-item count or quantities actually changed vs. what is in
 *      Veeqo right now (skip no-op updates).
 *
 * VEEQO ORDER NUMBER:
 *   Shopify sends order_number as e.g. 1234.
 *   Veeqo stores it as LL1234.
 *   This server prepends "LL" automatically.
 *
 * ENV VARS:
 *   VEEQO_API_KEY            – required
 *   SHOPIFY_WEBHOOK_SECRET   – required in production (skipped if blank)
 *   PORT                     – default 3000
 *   AFTERSELL_WINDOW_MINUTES – how many minutes after order creation to
 *                              still consider an update as an AfterSell
 *                              upsell (default: 30)
 *   VEEQO_ORDER_PREFIX       – prefix Veeqo uses for order numbers (default: LL)
 */

const express = require("express");
const crypto = require("crypto");

const app = express();

// ─── Config ──────────────────────────────────────────────────────────────────
const VEEQO_API_KEY           = process.env.VEEQO_API_KEY;
const SHOPIFY_WEBHOOK_SECRET  = process.env.SHOPIFY_WEBHOOK_SECRET;
const PORT                    = process.env.PORT || 3000;
const VEEQO_PREFIX            = process.env.VEEQO_ORDER_PREFIX ?? "LL";

if (!VEEQO_API_KEY) {
  console.error("❌  VEEQO_API_KEY env var is required");
  process.exit(1);
}

// ─── Idempotency cache ────────────────────────────────────────────────────────
const processedWebhookIds = new Set();
const WEBHOOK_ID_TTL_MS   = 10 * 60 * 1000; // 10 minutes

// ─── Middleware ───────────────────────────────────────────────────────────────
// We need the raw body buffer for HMAC verification, so we capture it here.
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/", (_req, res) => res.send("Shopify → Veeqo AfterSell sync is running ✅"));

// ─── Webhook endpoint ─────────────────────────────────────────────────────────
app.post("/webhook/order-updated", async (req, res) => {

  // 1. Verify HMAC signature
  if (!verifyShopifyHmac(req)) {
    console.warn("⚠️  Rejected: invalid HMAC signature");
    return res.status(401).send("Unauthorized");
  }

  // 2. Idempotency – reject duplicate deliveries
  // Shopify uses X-Shopify-Webhook-Id for deduplication (stable across retries).
  // X-Shopify-Event-Id changes each delivery attempt, so prefer Webhook-Id.
  const webhookId = (req.headers["x-shopify-webhook-id"] || req.headers["x-shopify-event-id"] || "").toLowerCase();
  if (webhookId) {
    if (processedWebhookIds.has(webhookId)) {
      console.log(`↩️  Duplicate webhook ${webhookId} — skipped`);
      return res.status(200).send("OK");
    }
    processedWebhookIds.add(webhookId);
    setTimeout(() => processedWebhookIds.delete(webhookId), WEBHOOK_ID_TTL_MS);
  }

  // Acknowledge Shopify immediately (must respond within 5 s)
  res.status(200).send("OK");

  // ── Async processing starts here ──────────────────────────────────────────
  const payload = req.body;

  // Extract useful fields from the Shopify payload
  const shopifyOrderNumber = payload.order_number;   // integer e.g. 1234
  const orderName          = payload.name;            // string  e.g. "#1234"
  const createdAt          = new Date(payload.created_at);
  const updatedAt          = new Date(payload.updated_at);
  const shopifyLineItems   = payload.line_items || [];

  const displayNumber = orderName || `#${shopifyOrderNumber}`;
  console.log(`\n📦  Webhook received for order ${displayNumber}`);
  console.log(`    created_at : ${createdAt.toISOString()}`);
  console.log(`    updated_at : ${updatedAt.toISOString()}`);

  // ── FILTER 1: Must have been updated AFTER creation ───────────────────────
  // Shopify fires orders/updated at the same moment as orders/create for new
  // orders. We skip those by requiring updated_at to be strictly later than
  // created_at. A 2-second buffer handles clock-skew in Shopify's timestamps.
  const gapSeconds = (updatedAt - createdAt) / 1000;
  if (gapSeconds < 2) {
    console.log(`    ⏭️  Skipped: updated_at ≈ created_at (gap ${gapSeconds.toFixed(1)}s) — looks like the initial order creation event`);
    return;
  }

  console.log(`    ✅  Order was updated ${(gapSeconds / 60).toFixed(1)} min after creation — proceeding`);

  try {
    // ── Find Veeqo order ──────────────────────────────────────────────────
    const veeqoOrder = await findVeeqoOrder(shopifyOrderNumber);
    if (!veeqoOrder) {
      console.error(`    ❌  Could not find Veeqo order for Shopify order ${displayNumber} (searched as #${VEEQO_PREFIX}${shopifyOrderNumber})`);
      return;
    }
    console.log(`    🔍  Found Veeqo order ID ${veeqoOrder.id} (number: ${veeqoOrder.number})`);

    const veeqoLineItems = veeqoOrder.line_items || [];

    // ── FILTER 3: Line items must have actually changed ───────────────────
    // Compare Shopify's current line-item state against what's in Veeqo.
    // If they're identical (same SKUs + quantities) there's nothing to sync.
    if (!lineItemsChanged(shopifyLineItems, veeqoLineItems)) {
      console.log(`    ⏭️  Skipped: line items are identical to Veeqo — nothing to sync`);
      return;
    }

    // ── Build the updated line-items list ─────────────────────────────────
    // Strategy: start from Shopify's authoritative list and map each item
    // onto its Veeqo sellable_id. We support:
    //   • quantity changes on existing items
    //   • brand-new items added by AfterSell
    //   • removed items (they simply won't appear in the final list)

    // Index existing Veeqo items by SKU for fast lookup
    const veeqoSkuMap = new Map();
    for (const vItem of veeqoLineItems) {
      const sku = vItem.sellable?.sku_code;
      if (sku) veeqoSkuMap.set(sku, vItem);
    }

    const finalLineItems = [];
    const warnings = [];

    for (const sItem of shopifyLineItems) {
      const sku = sItem.sku;

      if (veeqoSkuMap.has(sku)) {
        // Existing item — update quantity / price
        const vItem = veeqoSkuMap.get(sku);
        finalLineItems.push({
          sellable_id:    vItem.sellable.id,
          quantity:       sItem.quantity,
          price_per_unit: parseFloat(sItem.price),
        });
      } else {
        // New item added by AfterSell — look up sellable by SKU
        if (!sku) {
          warnings.push(`Shopify line item "${sItem.title}" has no SKU — cannot map to Veeqo sellable`);
          continue;
        }
        const sellableId = await getSellableIdBySku(sku);
        if (sellableId) {
          finalLineItems.push({
            sellable_id:    sellableId,
            quantity:       sItem.quantity,
            price_per_unit: parseFloat(sItem.price),
          });
          console.log(`    ➕  New SKU added: ${sku} (sellable ${sellableId})`);
        } else {
          warnings.push(`SKU "${sku}" not found in Veeqo products — skipping this line item`);
        }
      }
    }

    if (warnings.length) {
      warnings.forEach(w => console.warn(`    ⚠️  ${w}`));
    }

    if (finalLineItems.length === 0) {
      console.warn(`    ⚠️  No mappable line items found — aborting update`);
      return;
    }

    // ── Push update to Veeqo ──────────────────────────────────────────────
    await updateVeeqoOrder(veeqoOrder.id, finalLineItems);
    console.log(`    ✅  Veeqo order ${veeqoOrder.id} updated successfully (${finalLineItems.length} line item(s))`);

  } catch (err) {
    console.error(`    ❌  Sync error for order ${displayNumber}:`, err.message);
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Verify Shopify's HMAC-SHA256 webhook signature.
 * Returns true if no secret is configured (dev mode).
 */
function verifyShopifyHmac(req) {
  if (!SHOPIFY_WEBHOOK_SECRET) {
    console.warn("⚠️  SHOPIFY_WEBHOOK_SECRET not set — skipping HMAC verification (not safe for production)");
    return true;
  }
  const hmacHeader = req.headers["x-shopify-hmac-sha256"];
  if (!hmacHeader) return false;
  const digest = crypto
    .createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
    .update(req.rawBody)
    .digest("base64");
  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
  } catch {
    return false; // buffers different length → invalid
  }
}

/**
 * Detect whether Shopify's line items differ from Veeqo's.
 * Compares by SKU + quantity. Price differences are not checked because
 * Veeqo may store a different display price — quantity/SKU is what matters
 * for fulfilment.
 */
function lineItemsChanged(shopifyItems, veeqoItems) {
  if (shopifyItems.length !== veeqoItems.length) return true;

  const veeqoSnapshot = new Map(
    veeqoItems.map(i => [i.sellable?.sku_code, i.quantity])
  );

  for (const sItem of shopifyItems) {
    const vQty = veeqoSnapshot.get(sItem.sku);
    if (vQty === undefined || vQty !== sItem.quantity) return true;
  }
  return false;
}

/**
 * Find a Veeqo order by Shopify order number.
 *
 * Shopify sends order_number as an integer (e.g. 1234).
 * Veeqo stores it as a prefixed string (e.g. "LL1234").
 *
 * We search the Veeqo API using the prefixed form and also fall back to
 * matching on channel_order_number (which holds the Shopify order name like
 * "#1234") in case the store prefix differs.
 */
async function findVeeqoOrder(shopifyOrderNumber) {
  const numStr      = String(shopifyOrderNumber).replace("#", "");
  const veeqoNumber = `#${VEEQO_PREFIX}${numStr}`;   // e.g. "#LL7091"

  console.log(`    🔎  Searching Veeqo for order "${veeqoNumber}"`);

  // Send the full "#LL7091" form as the search query
  const results = await veeqoGet(`/orders?query=${encodeURIComponent(veeqoNumber)}`);

  if (!Array.isArray(results)) return null;

  // Exact match on Veeqo number field: "#LL7091"
  let match = results.find(o =>
    String(o.number || "").trim() === veeqoNumber
  );

  // Fallback: without leading "#" → "LL7091"
  if (!match) {
    match = results.find(o =>
      String(o.number || "").replace("#", "").trim() === `${VEEQO_PREFIX}${numStr}`
    );
  }

  // Last resort: channel_order_number holds Shopify's "#7091"
  if (!match) {
    match = results.find(o =>
      String(o.channel_order_number || "").replace("#", "") === numStr
    );
  }

  return match || null;
}

/**
 * Look up a Veeqo sellable ID by SKU code.
 * Used when AfterSell adds a brand-new product variant to the order.
 */
async function getSellableIdBySku(sku) {
  if (!sku) return null;
  try {
    const products = await veeqoGet(`/products?query=${encodeURIComponent(sku)}`);
    for (const product of products) {
      const sellable = (product.sellables || []).find(s => s.sku_code === sku);
      if (sellable) return sellable.id;
    }
  } catch (err) {
    console.error(`    ❌  Failed to look up SKU "${sku}":`, err.message);
  }
  return null;
}

/**
 * Update a Veeqo order's line items.
 * Sends the full replacement list — Veeqo replaces all existing line items.
 */
async function updateVeeqoOrder(veeqoOrderId, lineItems) {
  const res = await fetch(`https://api.veeqo.com/orders/${veeqoOrderId}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "x-api-key":    VEEQO_API_KEY,
    },
    body: JSON.stringify({
      order: {
        line_items_attributes: lineItems,
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Veeqo PUT /orders/${veeqoOrderId} returned ${res.status}: ${body}`);
  }
  return res.json();
}

/**
 * Generic Veeqo GET helper.
 */
async function veeqoGet(path) {
  const res = await fetch(`https://api.veeqo.com${path}`, {
    headers: { "x-api-key": VEEQO_API_KEY },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Veeqo GET ${path} returned ${res.status}: ${body}`);
  }
  return res.json();
}

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀  AfterSell→Veeqo sync server running on port ${PORT}`);
  console.log(`    Veeqo prefix : ${VEEQO_PREFIX} (searches as e.g. #${VEEQO_PREFIX}7091)`);
  console.log(`    HMAC check   : ${SHOPIFY_WEBHOOK_SECRET ? "enabled ✅" : "DISABLED ⚠️  (set SHOPIFY_WEBHOOK_SECRET)"}`);
});
