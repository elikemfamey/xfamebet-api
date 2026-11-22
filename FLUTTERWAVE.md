# Nigerian Flutterwave deposits

The deposit page adds a Flutterwave tab for eligible Nigerian accounts when the API has a configured gateway. It uses the existing NGN 30,000 deposit minimum.

This integration uses Flutterwave v3 hosted checkout. See the [checkout guide](https://developer.flutterwave.com/docs/collections-inflow/flutterwave-standard), [transaction verification guide](https://developer.flutterwave.com/docs/transaction-verification), and [v3 webhook guide](https://developer.flutterwave.com/docs/webhooks).

## Test checkout

Set `FLUTTERWAVE_TEST_SECRET_KEY` in the API environment and run the API in development. Test checkout uses the Flutterwave test key and a short-lived Redis reference. Verification displays a test result without crediting a wallet.

## Live checkout

1. Apply [the Flutterwave SQL migration](src/db/migrations/20261122_flutterwave_ngn.sql) to the intended Supabase database.
2. Set `FLUTTERWAVE_SECRET_KEY` and `FLUTTERWAVE_WEBHOOK_HASH` in the API's secret configuration. Set `FRONTEND_URL` to the customer site’s HTTPS origin.
3. In Flutterwave, set the webhook URL to the API origin followed by `/api/payments/flutterwave/webhook`. Use the same secret hash and enable webhook retries.
4. Set `FLUTTERWAVE_LIVE_ENABLED=true` on the API after the migration and webhook are ready.

The API checks the payment ID, its deposit reference, successful status, NGN currency, and exact amount against Flutterwave. The database records and credits the deposit in one transaction. A repeated provider notification or checkout return can resolve to the same completed payment without creating another credit.

The gateway credits eligible NGN wallets. An unlocked, empty wallet can adopt NGN on its first verified deposit. A wallet locked to another currency uses another deposit method. If a confirmed payment cannot be credited, the user can retry verification or give the deposit reference to support.
