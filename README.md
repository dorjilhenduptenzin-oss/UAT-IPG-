# CARDZONE 3DS / IPG UAT TEST TOOL

Bank of Bhutan UAT testing utility for Cardzone 3DS/IPG integration.

## UAT-Only Warning

This tool is only for UAT diagnostics and flow validation.

- ENVIRONMENT is fixed to UAT.
- Production endpoints are blocked by configuration guards.
- Do not use this as a production payment system.
- Do not commit .env or private keys.

## What This Tool Does

- Creates UAT transactions with unique transaction IDs.
- Performs mkReq key exchange (JSON POST).
- Builds MPIReq and signs MPI_MAC using SHA256withRSA.
- Generates hosted payment auto-submit form for mercReq (form-urlencoded browser POST).
- Accepts callback and verifies callback MAC with Cardzone public key.
- Supports inquiry request construction and submission.
- Stores UAT transaction audit in JSON files.
- Exports safe diagnostics for Cardzone support.

## Stack

- Node.js (recommended v20+)
- Express
- Plain HTML/CSS/JavaScript frontend

## Install

1. Copy environment template:

```bash
cp .env.example .env
```

2. Install dependencies:

```bash
npm install
```

3. Start server:

```bash
npm run dev
```

or

```bash
npm start
```

## Deployment Architecture (Vercel)

This project uses one Express app for both local and Vercel execution.

- Local entry: `src/server.js` (calls `app.listen(...)`)
- Vercel entry: `api/index.js` (exports the same `src/app.js` instance)
- Vercel catch-all: `api/[...path].js` delegates to `api/index.js`
- Vercel routing: `vercel.json` rewrites all paths to `/api/index`

Flow:

- Vercel -> `vercel.json` -> `api/index.js` -> `src/app.js` -> `src/routes/api.js` -> services

## Environment Variables

Use `.env`:

- `ENVIRONMENT=UAT`
- `MODE=UAT|MOCK`
- `PORT`
- `MERCHANT_ID`
- `CARDZONE_MKREQ_URL`
- `CARDZONE_MERC_REQ_URL`
- `CARDZONE_INQUIRY_URL`
- `MERCHANT_PRIVATE_KEY_PEM_PATH`
- `DATA_DIR` (optional writable data root override)
- `APP_VERSION` (optional deploy/version label)
- `ENABLE_MKREQ_MAC=false`
- `MPI_MAC_INCLUDE_RESPONSE_TYPE=false`
- `MPI_MAC_PURCHASE_DATE_TIMEZONE=ASIA_THIMPHU`
- `CALLBACK_BASE_URL`
- `RETURN_BASE_URL`
- `USE_CARDZONE_PROXY=true|false`
- `CARDZONE_PROXY_HOST`
- `CARDZONE_PROXY_PORT`
- `HTTP_PROXY`
- `HTTPS_PROXY`

Proxy note:

- Local/corporate environments may require `USE_CARDZONE_PROXY=true`.
- Serverless deployments (for example Vercel) should usually use `USE_CARDZONE_PROXY=false`.
- If proxy is enabled in serverless, the proxy host must be publicly reachable from that runtime.

URL intent:

- `CALLBACK_BASE_URL`: merchant server callback base used for server-side integrations and diagnostics.
- `RETURN_BASE_URL`: customer browser return base used in `MPI_RESPONSE_LINK` (for example `/api/return?txnId=...`).

Localhost note:

- A remote Cardzone server cannot call `http://localhost` on your machine.
- Browser return to `localhost` works only when the customer's browser and this Node app run on the same machine.

### Required UAT Values

- `ENVIRONMENT=UAT`
- `MERCHANT_ID=863990035600270`
- `CARDZONE_MKREQ_URL=https://uatczsecure.bob.bt/3dss/mkReq`
- `CARDZONE_MERC_REQ_URL=https://uatczsecure.bob.bt/3dss/mercReq`
- `CARDZONE_INQUIRY_URL=https://uatczsecure.bob.bt/3dss/mercReq`
- `MPI_MAC_INCLUDE_RESPONSE_TYPE=false`
- `MPI_MAC_PURCHASE_DATE_TIMEZONE=ASIA_THIMPHU`
- `RETURN_BASE_URL=https://uatipg.vercel.app`
- `CALLBACK_BASE_URL=https://uatipg.vercel.app`

## UAT Endpoints

Default endpoints used:

- mkReq: `https://uatczsecure.bob.bt/3dss/mkReq`
- mercReq: `https://uatczsecure.bob.bt/3dss/mercReq`
- inquiry: `https://uatczsecure.bob.bt/3dss/mercReq`

## Read-Only UAT EMV3DS Configuration

Exposed in the UI and API:

- Param ID: EMV3DS
- Start Version: 1.0
- End Version: 2.2.0
- Reference Number: 3DS_LOA_SER_CASB_020301_00986
- Proxy Server: 192.168.15.201
- Proxy Port: 3128
- Requestor URL: https://uatczsecure.bob.bt/3dss/rreq
- RReq URL: https://uatczsecure.bob.bt/3dss/rreq
- CRes URL: https://uatczsecure.bob.bt/3dss/cresp
- Notification URL: https://uatczsecure.bob.bt/3dss/notifyReq
- Timeouts: 10 seconds each

## Cardzone Flow Implemented

1. Create transaction
2. Generate/load RSA key pair
3. mkReq key exchange
4. Build MPIReq fields
5. Build canonical MPI MAC input (35 field order)
6. Sign with SHA256withRSA
7. Local verify signature
8. Build hosted payment form (mercReq)
9. Receive callback
10. Verify callback MAC
11. Optional inquiry
12. Final status mapping

## mkReq

- Method: `POST`
- Content-Type: `application/json`
- Endpoint: `CARDZONE_MKREQ_URL`

Payload:

```json
{
  "merchantId": "...",
  "purchaseId": "...",
  "pubKey": "..."
}
```

## MPIReq and MPI_MAC

- `purchaseId` is reused as `MPI_TRXN_ID`.
- MPI MAC canonical input uses the fixed Cardzone positional order.
- No top-level separators are inserted.
- Empty fields are included as empty strings and not skipped.
- Signature algorithm: SHA256withRSA.
- Signature encoding: Base64URL without padding.

## Callback

- Endpoint: `POST /api/callback`
- Form-encoded callback fields are parsed.
- Callback MAC is verified with Cardzone public key from mkReq response.
- Unverified callback is not trusted as authoritative success.
- This endpoint is not the customer-facing result page.

## Return

- Endpoint: `GET /api/return?txnId=...`
- Used for browser/customer-facing final result view.
- Reads stored transaction state and displays callback/inquiry driven status.

## Inquiry

- Uses transaction request field model with `MPI_TRANS_TYPE=INQ`.
- Uses `MPI_ORI_TRXN_ID` of original transaction.
- In UAT mode, performs form-urlencoded POST to configured inquiry endpoint.
- In MOCK mode, returns a local deterministic response.

## Troubleshooting 5A0

When `MPI_ERROR_CODE=5A0`, the tool shows a dedicated panel with:

- transaction id
- merchant id
- mkReq status
- key fingerprint
- signing input SHA-256
- signing input length
- MPI_MAC length
- key match status
- signed value hash vs submitted value hash

Message shown:

`The merchant generated a locally valid signature, but Cardzone did not accept it.`

## Security Precautions

- Never stores CVV in transaction files.
- Never logs full PAN.
- Never exposes private key via API/UI.
- Optional local private key persistence for UAT is explicit and file-permissioned.
- `.env` is ignored by git.

## Transaction Storage

- Local default directory: `./data/transactions`
- Serverless runtime (for example Vercel): `${os.tmpdir()}/uat-ipg-testing/data/transactions`
- Override data root with `DATA_DIR` when needed.
- File pattern: `txn_<transactionId>.json`

## API Summary

- `GET /health`
- `GET /api/config`
- `POST /api/transactions`
- `POST /api/transactions/:txnId/mkreq`
- `POST /api/transactions/:txnId/mpireq`
- `GET /api/transactions/:txnId/hosted-form`
- `POST /api/callback`
- `GET /api/return?txnId=...`
- `POST /api/return`
- `POST /api/transactions/:txnId/inquiry`
- `GET /api/tx/:txnId`
- `GET /api/transactions`
- `GET /api/transactions/:txnId/diagnostic`
- `POST /api/payment-links`
- `GET /pay/:token`

## Payment Link Feature

UAT-only convenience feature:

- `POST /api/payment-links`
- `GET /pay/:token`

TTL default is 30 minutes.

## Test and Validation

Run:

```bash
npm test
npm run lint
npm run build
```

Then verify:

- `GET /`
- `GET /health`

Use MOCK mode for safe app-level validation.

## Important Notes

- Local MAC verification pass does not prove Cardzone accepted the MAC.
- Do not claim payment success unless callback MAC is verified and result/inquiry confirms final state.

## Runtime Diagnostic

Use `GET /api/config` to verify active deployment configuration without exposing secrets.
This includes:

- `appVersion`
- `environment`
- `merchantId`
- `endpoints.mkReq`
- `endpoints.mercReq`
- `mpiMacIncludeResponseType`
- `mpiMacPurchaseDateTimezone`
- `callbackBaseUrl`
- `returnBaseUrl`

