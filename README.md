# hubspot-pandadoc-values-card

HubSpot CRM UI extension card for displaying related PandaDoc document values directly on HubSpot **Deal** records (called “Job” in this portal).

## What this does

On a Deal/Job record, the card:
- Reads the current record `hs_object_id` (native Deal ID).
- Calls a HubSpot serverless function (secure backend).
- Serverless function calls PandaDoc native API.
- Finds matching PandaDoc documents by Deal ID-first matching.
- Returns normalized document rows and summary totals.

## Data contract returned by backend

```json
{
  "documents": [
    {
      "id": "string",
      "name": "string",
      "status": "string",
      "value": 0,
      "currency": "string | null",
      "createdAt": "string | null",
      "createdBy": "string | null",
      "url": "string | null"
    }
  ],
  "totals": {
    "draft": 0,
    "sentViewed": 0,
    "completedSigned": 0,
    "overall": 0
  }
}
```

## PandaDoc `Document.Value` notes

For most PandaDoc accounts, document monetary total is returned as `value` on document list/detail payloads.
The serverless function treats `value` as the primary source and includes fallback reads for account payload variants:
- `pricing.grand_total`
- `pricing.totals.grand_total`

If none exist, `value` is returned as `null`.

## Matching logic (Deal ID first)

The backend tries these in order:
1. `metadata.hubspot_deal_id == {dealId}`
2. `metadata.hs_object_id == {dealId}`
3. `tag == hubspot-deal-{dealId}`
4. Fallback only: text query `q={dealId}`

> Recommendation: store native HubSpot Deal ID in PandaDoc metadata when creating documents, so matching is deterministic.

## Security model

- PandaDoc API key is read from `PANDADOC_API_KEY` server secret.
- No PandaDoc API requests are made from the browser.
- API key is never logged or returned to client.
- Integration is read-only.

## Files changed

- `hsproject.json`
- `src/app/extensions/PandaDocDocumentValuesCard.jsx`
- `src/app/app.functions/getPandaDocDocuments.js`
- `.env.example`
- `README.md`

## HubSpot app scopes required

Minimum recommended scopes:
- `crm.objects.deals.read`
- `crm.schemas.deals.read` (optional but useful for object metadata)

For deploying UI extension/serverless in your developer app, ensure platform/project deployment permissions are granted in HubSpot developer account.

## PandaDoc credentials setup

1. In PandaDoc, generate an API key with document read access.
2. In HubSpot project secrets, set:
   - `PANDADOC_API_KEY`
3. Do not put this key in frontend environment variables.

## Environment variables

- `PANDADOC_API_KEY` (required)

See `.env.example` for placeholder.

## Local test instructions

1. Install dependencies for HubSpot projects CLI + UI extensions runtime.
2. Authenticate CLI with your HubSpot developer account.
3. Set secret:
   - `hs secrets add PANDADOC_API_KEY`
4. Run project dev mode:
   - `hs project dev`
5. Open a Deal record in portal and add/view the card.

Validate states:
- Loading state appears initially.
- Error state appears if PandaDoc API is unreachable.
- “No PandaDoc documents found.” when no matches.
- Document links open PandaDoc.
- Totals render as USD.

## Deployment instructions

1. Configure secret in target account:
   - `hs secrets add PANDADOC_API_KEY`
2. Deploy project:
   - `hs project upload`
   - `hs project deploy`
3. Add the CRM card to Deal record right sidebar/tab in HubSpot UI.

## Limitations / caveats

- PandaDoc search filters can vary by account and API version behavior; metadata-based matching should be validated in your tenant.
- If historical documents lack Deal metadata, fallback text query may over/under-match.
- Currency is currently formatted as USD in UI per requirement; mixed-currency docs are not converted.
- Some PandaDoc docs may not expose owner fields consistently; `createdBy` can be null.
