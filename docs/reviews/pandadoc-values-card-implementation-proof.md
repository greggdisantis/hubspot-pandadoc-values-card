# PandaDoc Values Card – Implementation Proof

Date: 2026-05-10  
Repo: `hubspot-pandadoc-values-card`

## 1) Scope to native HubSpot Deal object

The extension manifest scopes the CRM card to the native **Deal** object using:

- `objectTypes: [{ "name": "deals" }]`

This confirms it is not built against a custom Job object and instead uses native Deal records (renamed “Job” in this portal).

## 2) Where the card reads the HubSpot Deal/Job ID

In `PandaDocDocumentValuesCard.jsx`, the card reads the current Deal ID from HubSpot context:

- `const dealId = context?.crm?.objectId || context?.crm?.properties?.hs_object_id;`

This uses the current native Deal record ID (`hs_object_id`).

## 3) How frontend calls backend/serverless

The frontend calls HubSpot serverless using `runServerlessFunction`:

```js
const response = await runServerlessFunction({
  name: 'getPandaDocDocuments',
  parameters: { dealId: String(dealId) },
});
```

This keeps PandaDoc API calls out of the browser.

## 4) How PandaDoc API key is protected

The API key is loaded only in the serverless function from environment secrets:

- `const apiKey = process.env.PANDADOC_API_KEY;`

The key is never sent to client code and is only used in server-side request headers:

- `Authorization: API-Key <secret>`

No key logging is implemented.

## 5) How PandaDoc documents are matched to HubSpot Deal ID

Matching is Deal-ID-first with ordered queries in the serverless function:

1. `metadata.hubspot_deal_id={dealId}`
2. `metadata.hs_object_id={dealId}`
3. `tag=hubspot-deal-{dealId}`

The implementation collects unique document IDs into a map to avoid duplicates and enriches each with details endpoint data.

## 6) Where `Document.Value` is pulled from

Primary field:

- `doc.value`

The function comment states this is the primary PandaDoc monetary field expected on list/details payloads.

## 7) Fallback value fields

If `value` is missing, fallback fields are checked:

- `doc.pricing.grand_total`
- `doc.pricing.totals.grand_total`

If none are available or numeric, the normalized `value` is set to `null`.

## 8) Fallback document matching when Deal ID match fails

Last-resort fallback query:

- `q={dealId}`

The code marks this as not recommended for permanent matching and only uses it when metadata/tag matching does not produce usable results.

## 9) Data returned to the card

Serverless returns:

```json
{
  "documents": [
    {
      "id": "string",
      "name": "string",
      "status": "string",
      "value": "number|null",
      "currency": "string|null",
      "createdAt": "string|null",
      "createdBy": "string|null",
      "url": "string|null"
    }
  ],
  "totals": {
    "draft": "number",
    "sentViewed": "number",
    "completedSigned": "number",
    "overall": "number"
  }
}
```

`totals` are aggregated server-side from normalized values and grouped by status class.

## 10) User-visible states in the card

### Loading
- Shows spinner and text: “Loading PandaDoc documents…”.

### Error
- Shows red error text when serverless call fails or API is unreachable.

### Empty
- Shows: “No PandaDoc documents found.” when no matched documents are returned.

### Success
- Shows grouped totals (Draft, Sent/viewed, Completed/signed, Overall) formatted in USD.
- Shows compact table with name, status, value, created date, owner.
- Document name is link-enabled when URL exists.
- Also includes “Open latest PandaDoc document” button when available.

## 11) Read-only confirmation

Confirmed read-only behavior:

- Frontend only reads/render data.
- Serverless only performs `GET` requests to PandaDoc endpoints.
- No HubSpot CRM write APIs are called.
- No PandaDoc create/update/delete endpoints are called.

Therefore, this implementation does **not** modify HubSpot or PandaDoc records.

## 12) Risks, limitations, assumptions before deployment

1. **PandaDoc query behavior may vary by account/API behavior** for metadata filtering; verify in tenant.
2. **Fallback text query (`q`) can over/under-match** if historical docs do not include Deal metadata.
3. **Currency handling**: UI formats all totals as USD by requirement; mixed-currency documents are not converted.
4. **Owner fields can be sparse** (`owner` / `created_by`) and may return null.
5. **Status taxonomy assumptions**: grouped totals rely on explicit status mapping and may need adjustment for account-specific status usage.
6. **No pagination handling yet** for large result sets; current logic assumes enough results in initial responses.
7. **Detail endpoint availability**: if details call fails per document, fallback uses list payload fields where possible.

---

## Manual Test Checklist (HubSpot + PandaDoc)

### Prerequisites
- [ ] HubSpot project deployed and extension visible on Deal records.
- [ ] Secret `PANDADOC_API_KEY` configured in HubSpot environment.
- [ ] PandaDoc test documents exist in states: draft, sent/viewed, completed/signed.
- [ ] At least one PandaDoc doc includes deterministic Deal ID mapping (`metadata.hubspot_deal_id` or `metadata.hs_object_id`, or tag).

### Functional checks
- [ ] Open a HubSpot Deal (Job) record and confirm card renders.
- [ ] Confirm card uses current Deal `hs_object_id` by validating expected matched docs.
- [ ] Confirm loading state appears briefly.
- [ ] Confirm success state table shows: name, status, value, created date, owner.
- [ ] Click a document link and verify PandaDoc document opens.
- [ ] Verify grouped totals match expected sums by status.
- [ ] Verify overall total equals sum of all displayed document values.
- [ ] Verify value formatting is USD.

### Error/empty behavior
- [ ] Temporarily invalidate PandaDoc API key and confirm error state appears.
- [ ] Use a Deal with no related docs and confirm “No PandaDoc documents found.”

### Matching logic checks
- [ ] Confirm metadata match (`metadata.hubspot_deal_id`) returns correct docs.
- [ ] Confirm secondary metadata/tag matching works when primary metadata absent.
- [ ] Confirm text-query fallback behavior only as backup (and evaluate false positives).

### Security/read-only checks
- [ ] Inspect browser network requests: no PandaDoc API key exposed client-side.
- [ ] Confirm frontend calls only HubSpot serverless function.
- [ ] Confirm no HubSpot record properties are written.
- [ ] Confirm no PandaDoc documents are created/updated/deleted.

### Performance/usability checks
- [ ] Card remains compact in right sidebar layout.
- [ ] Response time is acceptable for typical number of related docs.
- [ ] Confirm behavior with missing owner/value/date fields degrades gracefully.
