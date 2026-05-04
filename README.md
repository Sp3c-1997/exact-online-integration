Overview
This service integrates Exact Online with your existing payment backend.

It:

Authenticates with Exact Online via OAuth2
Stores OAuth session/tokens in Supabase
Polls Exact invoices every 5 minutes
Selects invoices in the last 7 days (Created or Modified)
Filters to finalized invoices (Status = 50)
Enriches invoices with debtor email from Exact crm/Accounts
Calls your collect-payment endpoint with an idempotency key
Prerequisites
Exact Online app credentials (CLIENT_ID, CLIENT_SECRET)
Render deployment URL
Supabase project (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
A reachable COLLECT_PAYMENT_URL endpoint
Environment Variables
Use .env.example as reference.

Required:

CLIENT_ID
CLIENT_SECRET
REDIRECT_URI (must be https://<your-domain>/oauth/callback)
EXACT_BASE_URL (usually https://start.exactonline.nl)
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
COLLECT_PAYMENT_URL
Optional:

COLLECT_PAYMENT_TIMEOUT_MS (default: 15000)
EXACT_MOCK (1 for local mock fixtures, 0 for live Exact)
EXACT_DEBUG_LOGS (1 enables Exact debug logs)
LOG_DEBUG=1 or LOG_LEVEL=debug (to show logger.debug output)
Supabase Setup
Run SQL from:

db/sql/exact_oauth_session.sql
This creates the exact_oauth_session table used for OAuth token persistence.

OAuth Setup
Deploy service to Render.
Set REDIRECT_URI to:
https://<your-render-domain>/oauth/callback
Configure the same callback URL in Exact Online app settings.
Open:
https://<your-render-domain>/oauth/start
Complete consent flow.
Confirm callback success and Supabase row creation.
How Processing Works
Every 5 minutes:

Fetch invoices from Exact (last 7 days by Created OR Modified)
Apply local date safety filter (same 7-day rule)
Enrich with debtor email
Keep only processable invoices:
finalized (Status = 50)
positive amount
debtor id present
invoice number present
debtor email present
Send payload to COLLECT_PAYMENT_URL
Payload Sent to collect-payment
Example:

{
"email": "billing@acme.example",
"amount": 5000,
"description": "Invoice 1002",
"invoice_number": "1002",
"exact_debtor_id": "11111111-1111-1111-1111-111111111111",
"idempotency_key": "exact-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa0002"
}
Operational Notes
Polling starts automatically when server starts.
On sleeping/free Render instances, polling pauses when instance sleeps.
For reliable 5-minute polling, use an always-on instance.
If COLLECT_PAYMENT_URL is missing, processing logs:
Missing COLLECT_PAYMENT_URL
Mock Mode (Local Testing)
Set:

EXACT_MOCK=1
Then service reads fixtures from:

data/exact-mock/sales-invoices.json
data/exact-mock/accounts.json
Set EXACT_MOCK=0 to use live Exact API.

Troubleshooting
No invoices processed
Check logs for:
fetched count
local 7-day filtered count
processable count
OAuth errors
Verify REDIRECT_URI match between env and Exact app
Confirm Supabase table exists
No payment trigger
Verify COLLECT_PAYMENT_URL
Verify endpoint is reachable and responds within timeout
No polling activity on Render
Instance may be sleeping; use always-on plan
