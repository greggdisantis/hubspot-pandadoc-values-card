const PANDADOC_BASE_URL = 'https://api.pandadoc.com/public/v1';
const HUBSPOT_BASE_URL = 'https://api.hubapi.com';
const LIST_TIMEOUT_MS = 8000;
const DETAIL_TIMEOUT_MS = 5000;
const MAX_DOCUMENTS = 50;

const toNumberOrNull = (value) => {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const cleaned = String(value).replace(/[$,\s]/g, '');
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
};
const normStr = (v) => String(v ?? '').trim();

const mapStatusGroup = (status) => {
  if (status === 'document.draft') return 'draft';
  if (['document.sent', 'document.viewed', 'document.waiting_approval', 'document.external_review'].includes(status)) return 'sentViewed';
  if (['document.completed', 'document.paid'].includes(status)) return 'completedSigned';
  return null;
};

const getTokenVariableValue = (doc, keyName) => {
  const keyLc = String(keyName).toLowerCase();
  for (const pool of [doc?.tokens, doc?.variables]) {
    if (!pool) continue;
    if (Array.isArray(pool)) {
      const hit = pool.find((t) => String(t?.name || t?.key || '').toLowerCase() === keyLc);
      if (hit) return hit?.value ?? hit?.text ?? null;
    } else if (typeof pool === 'object') {
      for (const [k, v] of Object.entries(pool)) if (String(k).toLowerCase() === keyLc) return v;
    }
  }
  return null;
};

const extractValue = (doc) => {
  const candidates = [
    getTokenVariableValue(doc, 'Document.Value'),
    doc?.grand_total?.amount,
    doc?.value,
    doc?.grand_total,
    doc?.grand_total?.value,
    doc?.grand_total?.total,
    doc?.pricing?.grand_total,
    doc?.pricing?.grand_total?.amount,
    doc?.pricing?.grand_total?.value,
    doc?.pricing?.grand_total?.total,
    doc?.pricing?.totals?.grand_total,
    doc?.pricing?.totals?.grand_total?.amount,
    doc?.pricing?.totals?.grand_total?.value,
    doc?.pricing?.totals?.grand_total?.total,
  ];
  for (const c of candidates) {
    const n = toNumberOrNull(c);
    if (n !== null) return n;
  }
  return null;
};

const normalizeCreatedBy = (doc) => doc?.owner?.email || ((doc?.owner?.first_name || doc?.owner?.last_name) ? `${doc.owner.first_name || ''} ${doc.owner.last_name || ''}`.trim() : null) || doc?.created_by?.email || null;
const buildDocUrl = (id) => (id ? `https://app.pandadoc.com/a/#/documents/${id}` : null);

const fetchWithTimeout = async (url, options, timeoutMs) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return { response, timedOut: false };
  } catch (error) {
    if (error?.name === 'AbortError') return { response: null, timedOut: true };
    throw error;
  } finally { clearTimeout(timer); }
};

const listDocs = async (url, headers) => {
  const res = await fetchWithTimeout(url, { method: 'GET', headers }, LIST_TIMEOUT_MS);
  if (!res.response || !res.response.ok) return { docs: [], timedOut: res.timedOut };
  const payload = await res.response.json();
  return { docs: (payload?.results || payload?.documents || []).slice(0, MAX_DOCUMENTS), timedOut: res.timedOut };
};

exports.main = async (context = {}) => {
  let timedOut = false, detailSuccesses = 0, detailFailures = 0;
  try {
    const dealId = normStr(context?.parameters?.dealId);
    const dealName = normStr(context?.parameters?.dealName);
    if (!dealId) return { statusCode: 400, body: { message: 'dealId is required.' } };

    const apiKey = process.env.PANDADOC_API_KEY;
    if (!apiKey) return { statusCode: 500, body: { message: 'Missing PANDADOC_API_KEY secret.' } };
    const headers = { Authorization: `API-Key ${apiKey}`, 'Content-Type': 'application/json' };

    // Priority 1: metadata and id based
    const q1 = await listDocs(`${PANDADOC_BASE_URL}/documents?metadata.hubspot.deal_id=${encodeURIComponent(dealId)}&count=${MAX_DOCUMENTS}`, headers);
    timedOut ||= q1.timedOut;
    const q2 = await listDocs(`${PANDADOC_BASE_URL}/documents?tag=${encodeURIComponent(`hubspot-deal-${dealId}`)}&count=${MAX_DOCUMENTS}`, headers);
    timedOut ||= q2.timedOut;

    let seedDocs = [...q1.docs, ...q2.docs];
    if (!seedDocs.length) {
      const q3 = await listDocs(`${PANDADOC_BASE_URL}/documents?count=${MAX_DOCUMENTS}`, headers);
      timedOut ||= q3.timedOut;
      seedDocs = q3.docs;
    }

    const byId = new Map(seedDocs.map((d) => [d.id, d]));
    const settled = await Promise.allSettled(Array.from(byId.values()).map(async (doc) => {
      if (!doc?.id) { detailFailures += 1; return doc; }
      const detailResult = await fetchWithTimeout(`${PANDADOC_BASE_URL}/documents/${doc.id}/details`, { method: 'GET', headers }, DETAIL_TIMEOUT_MS);
      timedOut ||= detailResult.timedOut;
      if (!detailResult.response || !detailResult.response.ok) { detailFailures += 1; return doc; }
      try { detailSuccesses += 1; return { ...doc, ...(await detailResult.response.json()) }; } catch { detailFailures += 1; return doc; }
    }));

    const scannedDocs = settled.map((r, idx) => (r.status === 'fulfilled' ? r.value : Array.from(byId.values())[idx]));

    const matchedDocs = scannedDocs.filter((doc) => {
      const checks = [
        normStr(doc?.metadata?.['hubspot.deal_id']),
        normStr(getTokenVariableValue(doc, 'Deal.DealID')),
        normStr(getTokenVariableValue(doc, 'Deal.HsObjectId')),
        normStr(getTokenVariableValue(doc, 'Deal.PandaDocMirrorJobId')),
      ];
      if (checks.some((v) => v && v === dealId)) return true;
      if (dealName && !checks.some(Boolean)) return normStr(doc?.name).toLowerCase().includes(dealName.toLowerCase());
      return false;
    });

    const documents = matchedDocs.map((doc) => ({
      id: doc?.id || null,
      name: doc?.name || null,
      status: doc?.status || null,
      value: extractValue(doc),
      currency: doc?.currency || doc?.pricing?.currency || null,
      createdAt: doc?.date_created || doc?.created_at || null,
      createdBy: normalizeCreatedBy(doc),
      url: doc?.link || buildDocUrl(doc?.id),
    }));

    const totals = documents.reduce((acc, doc) => {
      if (doc.value === null) return acc;
      acc.overall += doc.value;
      const g = mapStatusGroup(doc.status);
      if (g) acc[g] += doc.value;
      return acc;
    }, { draft: 0, sentViewed: 0, completedSigned: 0, overall: 0 });

    // Write back completed/signed total to HubSpot deal amount when changed
    const completed = totals.completedSigned;
    if (completed > 0) {
      const hsToken = process.env.HUBSPOT_ACCESS_TOKEN;
      if (hsToken) {
        const getDeal = await fetchWithTimeout(`${HUBSPOT_BASE_URL}/crm/v3/objects/deals/${encodeURIComponent(dealId)}?properties=amount`, { method: 'GET', headers: { Authorization: `Bearer ${hsToken}` } }, 5000);
        if (getDeal.response?.ok) {
          const dealPayload = await getDeal.response.json();
          const currentAmount = toNumberOrNull(dealPayload?.properties?.amount);
          if (currentAmount === null || currentAmount !== completed) {
            await fetchWithTimeout(`${HUBSPOT_BASE_URL}/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, {
              method: 'PATCH',
              headers: { Authorization: `Bearer ${hsToken}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ properties: { amount: String(completed) } }),
            }, 5000);
          }
        }
      }
    }

    return { statusCode: 200, body: { documents, totals, debug: { pandaDocMode: 'manual-token-or-metadata-match', scannedDocumentCount: scannedDocs.length, matchedDocumentCount: documents.length, detailSuccesses, detailFailures, timedOut, matchFieldsChecked: ['metadata.hubspot.deal_id', 'Deal.DealID', 'Deal.HsObjectId', 'Deal.PandaDocMirrorJobId'] } } };
  } catch (error) {
    return { statusCode: 502, body: { message: 'Unable to reach PandaDoc API.', error: error?.message || 'Unknown error', debug: { pandaDocMode: 'manual-token-or-metadata-match', scannedDocumentCount: 0, matchedDocumentCount: 0, detailSuccesses, detailFailures, timedOut, matchFieldsChecked: ['metadata.hubspot.deal_id', 'Deal.DealID', 'Deal.HsObjectId', 'Deal.PandaDocMirrorJobId'] } } };
  }
};
