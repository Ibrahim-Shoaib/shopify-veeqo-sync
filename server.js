const express = require("express");
const crypto = require("crypto");

const app = express();

// ── Config from environment variables ──────────────────────────────────────
const VEEQO_API_KEY = process.env.VEEQO_API_KEY;
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;
const PORT = process.env.PORT || 3000;

// ── FIX D: In-memory idempotency store ────────────────────────────────────
// Tracks recently processed webhook IDs to prevent duplicate processing.
// Shopify sometimes delivers the same webhook twice.
const processedWebhookIds = new Set();
const WEBHOOK_ID_TTL_MS = 5 * 60 * 1000; // forget after 5 minutes

// ── Raw body needed for HMAC verification ──────────────────────────────────
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

// ── Health check ────────────────────────────────────────────────────────────
app.get("/", (_req, res) => res.send("Shopify → Veeqo sync is running ✅"));

// ── FIX C: Subscribe to orders/updated instead of orders/edited ────────────
// orders/updated always provides the full, final state of the order.
// orders/edited uses a different payload shape (order_edit object) that
// is harder to work with and may not include the complete line items list.
app.post("/webhook/order-updated", async (req, res) => {
  // 1. Verify the request is genuinely from Shopify
  if (!verifyShopifyHmac(req)) {
    console.warn("⚠️  Invalid HMAC – request rejected");
    return res.status(401).send("Unauthorized");
  }

  // FIX D: Idempotency check — ignore duplicate webhook deliveries
  const webhookId = req.headers["x-shopify-webhook-id"] || req.headers["x-shopify-event-id"];
  if (webhookId) {
    if (processedWebhookIds.has(webhookId)) {
      console.log(`⏭️  Duplicate webhook ignored: ${webhookId}`);
      return res.status(200).send("OK");
    }
    processedWebhookIds.add(webhookId);
    // Auto-remove the ID after TTL to prevent the Set growing forever
    setTimeout(() => processedWebhookIds.delete(webhookId), WEBHOOK_ID_TTL_MS);
  }

  // Acknowledge Shopify immediately (must respond within 5 s)
  res.status(200).send("OK");

  const payload = req.body;
  const shopifyOrderId = payload.id;
  const shopifyOrderNumber = payload.order_number || payload.name;

  console.log(`\n📦 Order updated: ${shopifyOrderNumber} (Shopify ID: ${shopifyOrderId})`);

  try {
    // 2. Get the full current line items from the Shopify payload
    //    orders/updated always includes the complete line_items array
    const shopifyLineItems = payload.line_items || [];

    // 3. FIX B: Find Veeqo order using targeted search by order number
    //    instead of scanning the first 50 results
    const veeqoOrder = await findVeeqoOrder(shopifyOrderNumber);
    if (!veeqoOrder) {
      console.error(`   ❌ Could not find Veeqo order for ${shopifyOrderNumber}`);
      return;
    }

    console.log(`   ✅ Found Veeqo order ID: ${veeqoOrder.id}`);

    const veeqoLineItems = veeqoOrder.line_items || [];

    // 4. Detect added items (in Shopify but not in Veeqo)
    const newItems = findNewLineItems(shopifyLineItems, veeqoLineItems);

    // 5. Detect removed items (in Veeqo but no longer in Shopify)
    const removedItems = findRemovedLineItems(shopifyLineItems, veeqoLineItems);

    if (!newItems.length && !removedItems.length) {
      console.log("   ℹ️  No line item changes detected – nothing to sync");
      return;
    }

    if (newItems.length)     console.log(`   🆕 Items to add: ${newItems.length}`);
    if (removedItems.length) console.log(`   🗑️  Items to remove: ${removedItems.length}`);

    // 6. Build the list of items to KEEP (all Veeqo items minus removed ones)
    const removedSkus = new Set(
      removedItems.map((li) => li.sellable?.sku_code).filter(Boolean)
    );

    const keptItems = veeqoLineItems
      .filter((li) => !removedSkus.has(li.sellable?.sku_code))
      .map((li) => ({
        sellable_id: li.sellable.id,
        quantity: li.quantity,
        price_per_unit: li.price_per_unit,
      }));

    if (removedItems.length) {
      removedItems.forEach((li) =>
        console.log(`   - Removing SKU: ${li.sellable?.sku_code} (Veeqo line item ID: ${li.id})`)
      );
    }

    // 7. FIX A: Resolve sellable IDs using a targeted SKU search
    //    instead of paginating through the entire product catalog
    const lineItemsToAdd = [];
    for (const item of newItems) {
      const sku = item.sku;
      const sellableId = await getSellableIdBySku(sku);

      if (!sellableId) {
        console.warn(`   ⚠️  Could not find Veeqo sellable for SKU: ${sku} – skipping`);
        continue;
      }

      lineItemsToAdd.push({
        sellable_id: sellableId,
        quantity: item.quantity,
        price_per_unit: item.price,
      });

      console.log(`   + Adding SKU ${sku} (sellable_id: ${sellableId}) qty: ${item.quantity}`);
    }

    // 8. Final line items = kept existing + newly added
    const finalLineItems = [...keptItems, ...lineItemsToAdd];

    if (!finalLineItems.length) {
      console.log("   ⚠️  Final line items list is empty – skipping update to avoid empty order");
      return;
    }

    // 9. Push the updated line items to Veeqo
    await updateVeeqoOrder(veeqoOrder.id, finalLineItems);
    console.log(`   ✅ Veeqo order ${veeqoOrder.id} updated successfully!`);
  } catch (err) {
    console.error("   ❌ Error syncing order:", err.message);
  }
});

// ── Shopify HMAC verification ───────────────────────────────────────────────
function verifyShopifyHmac(req) {
  if (!SHOPIFY_WEBHOOK_SECRET) return true; // skip in dev if not set
  const hmac = req.headers["x-shopify-hmac-sha256"];
  if (!hmac) return false;
  const digest = crypto
    .createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
    .update(req.rawBody)
    .digest("base64");
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmac));
}

// ── FIX B: Find Veeqo order using targeted query search ────────────────────
// Uses Veeqo's query parameter to search by order number directly,
// instead of scanning through the first 50 results which misses older orders.
async function findVeeqoOrder(shopifyOrderNumber) {
  // Remove the # from the order number (e.g. #1001 -> 1001)
  const number = String(shopifyOrderNumber).replace("#", "");

  // FIX: Removed 'status=all' because Veeqo does not support it.
  // This query will now search across all statuses by default.
  const results = await veeqoGet(`/orders?query=${encodeURIComponent(number)}`);

  const match = results.find(
    (o) =>
      String(o.number || "").replace("#", "") === number ||
      String(o.channel_order_number || "").replace("#", "") === number
  );

  return match || null;
}

// ── FIX A: Find sellable_id using a direct SKU query (single API call) ─────
// Previously this paginated through the entire catalog (potentially 100s of
// API calls). Now it uses Veeqo's search to find the SKU in one request.
async function getSellableIdBySku(sku) {
  if (!sku) return null;

  const products = await veeqoGet(`/products?query=${encodeURIComponent(sku)}`);

  for (const product of products) {
    for (const sellable of product.sellables || []) {
      if (sellable.sku_code === sku) return sellable.id;
    }
  }

  return null;
}

// ── Detect new line items (in Shopify but not yet in Veeqo) ─────────────────
function findNewLineItems(shopifyItems, veeqoItems) {
  const veeqoSkus = new Set(
    (veeqoItems || []).map((li) => li.sellable?.sku_code).filter(Boolean)
  );
  return shopifyItems.filter((item) => item.sku && !veeqoSkus.has(item.sku));
}

// ── Detect removed line items (in Veeqo but no longer in Shopify) ───────────
function findRemovedLineItems(shopifyItems, veeqoItems) {
  const shopifySkus = new Set(
    (shopifyItems || []).map((item) => item.sku).filter(Boolean)
  );
  return (veeqoItems || []).filter(
    (li) => li.sellable?.sku_code && !shopifySkus.has(li.sellable.sku_code)
  );
}

// ── Update Veeqo order with final line items ─────────────────────────────────
async function updateVeeqoOrder(veeqoOrderId, lineItemsAttributes) {
  const response = await fetch(`https://api.veeqo.com/orders/${veeqoOrderId}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": VEEQO_API_KEY,
    },
    body: JSON.stringify({
      order: { line_items_attributes: lineItemsAttributes },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Veeqo API error ${response.status}: ${text}`);
  }

  return response.json();
}

// ── Generic Veeqo GET helper ─────────────────────────────────────────────────
async function veeqoGet(path) {
  const response = await fetch(`https://api.veeqo.com${path}`, {
    headers: { "x-api-key": VEEQO_API_KEY },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Veeqo GET ${path} failed ${response.status}: ${text}`);
  }
  return response.json();
}

// ── Start server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Shopify → Veeqo sync server running on port ${PORT}`);
  console.log(`   Webhook URL: https://YOUR-RAILWAY-URL/webhook/order-updated`);
  console.log(`   ⚠️  Remember: register 'orders/updated' in Shopify (not orders/edited)`);
});
