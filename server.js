const express = require("express");
const crypto = require("crypto");

const app = express();

const VEEQO_API_KEY = process.env.VEEQO_API_KEY;
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;
const PORT = process.env.PORT || 3000;

const processedWebhookIds = new Set();
const WEBHOOK_ID_TTL_MS = 5 * 60 * 1000;

app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; }
}));

app.get("/", (_req, res) => res.send("Shopify → Veeqo sync is running ✅"));

app.post("/webhook/order-updated", async (req, res) => {
  if (!verifyShopifyHmac(req)) return res.status(401).send("Unauthorized");

  const webhookId = req.headers["x-shopify-webhook-id"] || req.headers["x-shopify-event-id"];
  if (webhookId) {
    if (processedWebhookIds.has(webhookId)) return res.status(200).send("OK");
    processedWebhookIds.add(webhookId);
    setTimeout(() => processedWebhookIds.delete(webhookId), WEBHOOK_ID_TTL_MS);
  }

  res.status(200).send("OK");

  const payload = req.body;
  const shopifyOrderNumber = payload.order_number || payload.name;

  console.log(`\n📦 Order updated: ${shopifyOrderNumber}`);

  try {
    // 1. Find Veeqo order without the 'status=all' filter
    const veeqoOrder = await findVeeqoOrder(shopifyOrderNumber);
    if (!veeqoOrder) {
      console.error(`   ❌ Could not find Veeqo order for ${shopifyOrderNumber}. (If this is a Shopify test, this is normal!)`);
      return;
    }

    const shopifyLineItems = payload.line_items || [];
    const veeqoLineItems = veeqoOrder.line_items || [];

    // 2. Build final list using Shopify's current state (Handles adds, removes, AND quantity changes)
    const shopifyMap = new Map(shopifyLineItems.map(item => [item.sku, item]));
    const finalLineItems = [];

    // Check existing Veeqo items
    for (const vItem of veeqoLineItems) {
      const sku = vItem.sellable?.sku_code;
      if (shopifyMap.has(sku)) {
        const sItem = shopifyMap.get(sku);
        finalLineItems.push({
          sellable_id: vItem.sellable.id,
          quantity: sItem.quantity,
          price_per_unit: sItem.price,
        });
        shopifyMap.delete(sku); // Item processed
      }
    }

    // Check for brand new items
    for (const [sku, sItem] of shopifyMap) {
      const sellableId = await getSellableIdBySku(sku);
      if (sellableId) {
        finalLineItems.push({
          sellable_id: sellableId,
          quantity: sItem.quantity,
          price_per_unit: sItem.price,
        });
        console.log(`   + Adding new SKU: ${sku}`);
      }
    }

    await updateVeeqoOrder(veeqoOrder.id, finalLineItems);
    console.log(`   ✅ Veeqo order ${veeqoOrder.id} updated successfully!`);

  } catch (err) {
    console.error("   ❌ Sync Error:", err.message);
  }
});

function verifyShopifyHmac(req) {
  if (!SHOPIFY_WEBHOOK_SECRET) return true;
  const hmac = req.headers["x-shopify-hmac-sha256"];
  if (!hmac) return false;
  const digest = crypto.createHmac("sha256", SHOPIFY_WEBHOOK_SECRET).update(req.rawBody).digest("base64");
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmac));
}

async function findVeeqoOrder(shopifyOrderNumber) {
  const number = String(shopifyOrderNumber).replace("#", "");
  // FIX: Removed status=all. This now searches correctly.
  const results = await veeqoGet(`/orders?query=${encodeURIComponent(number)}`);
  return results.find(o => String(o.number || "").replace("#", "") === number || String(o.channel_order_number || "").replace("#", "") === number) || null;
}

async function getSellableIdBySku(sku) {
  if (!sku) return null;
  const products = await veeqoGet(`/products?query=${encodeURIComponent(sku)}`);
  for (const p of products) {
    const s = (p.sellables || []).find(s => s.sku_code === sku);
    if (s) return s.id;
  }
  return null;
}

async function updateVeeqoOrder(id, items) {
  const res = await fetch(`https://api.veeqo.com/orders/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "x-api-key": VEEQO_API_KEY },
    body: JSON.stringify({ order: { line_items_attributes: items } }),
  });
  if (!res.ok) throw new Error(`Veeqo API Error: ${res.status}`);
}

async function veeqoGet(path) {
  const res = await fetch(`https://api.veeqo.com${path}`, { headers: { "x-api-key": VEEQO_API_KEY } });
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
  return res.json();
}

app.listen(PORT, () => console.log(`🚀 Sync server live on port ${PORT}`));
