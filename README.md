# Shopify → Veeqo Order Sync
Automatically syncs AfterSell upsell line items from Shopify to Veeqo — free forever on Railway.

---

## How It Works
1. Customer accepts AfterSell upsell after checkout
2. AfterSell edits the Shopify order (adds the upsell product)
3. Shopify fires an `orders/edited` webhook to this server
4. This server finds the matching order in Veeqo
5. The new line item is added to the Veeqo order via API

---

## Setup Guide

### Step 1 — Deploy to Railway (Free)

1. Go to https://railway.app and sign up (free)
2. Click **New Project → Deploy from GitHub repo**
3. Upload these files OR connect your GitHub repo
4. Railway will auto-detect Node.js and deploy it

### Step 2 — Set Environment Variables on Railway

In your Railway project → **Variables** tab, add:

| Variable | Value |
|---|---|
| `VEEQO_API_KEY` | Your Veeqo API key (Settings → API in Veeqo) |
| `SHOPIFY_WEBHOOK_SECRET` | Your webhook secret (from Step 3 below) |
| `PORT` | `3000` |

### Step 3 — Add Shopify Webhook

1. In Shopify Admin go to **Settings → Notifications → Webhooks**
2. Click **Create webhook**
3. Set:
   - **Event:** `Order edited`
   - **Format:** `JSON`
   - **URL:** `https://YOUR-RAILWAY-URL.railway.app/webhook/order-edited`
4. Copy the **webhook signing secret** shown → paste into Railway as `SHOPIFY_WEBHOOK_SECRET`

### Step 4 — Test It

1. Place a test order on your Shopify store
2. Manually edit the order in Shopify admin (add a product)
3. Check Railway logs — you should see:
   ```
   📦 Order edited: #1001
   ✅ Found Veeqo order ID: 123456
   🆕 New line items to add: 1
   + Adding SKU ABC123 (sellable_id: 999) qty: 1
   ✅ Veeqo order updated successfully!
   ```
4. Check Veeqo — the new item should appear on the order

---

## Important Notes

- **SKU matching:** The script matches products by SKU code. Make sure your Shopify SKUs match exactly with Veeqo SKUs.
- **Railway free tier:** Includes 500 hours/month free — more than enough for a webhook server.
- **Logs:** View real-time logs in Railway dashboard to debug any issues.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| "Could not find Veeqo order" | Check that the Shopify order number matches in Veeqo |
| "Could not find Veeqo sellable for SKU" | Make sure the product SKU in Shopify matches exactly in Veeqo |
| "Invalid HMAC" | Check that `SHOPIFY_WEBHOOK_SECRET` is set correctly |
| No logs appearing | Check the webhook URL is correct in Shopify |
