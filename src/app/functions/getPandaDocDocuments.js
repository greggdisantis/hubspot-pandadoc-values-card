const PANDADOC_BASE_URL = 'https://api.pandadoc.com/public/v1';
const LIST_TIMEOUT_MS = 8000;
const DETAIL_TIMEOUT_MS = 5000;
const MAX_DOCUMENTS = 5;

const mapStatusGroup = (status) => {
  if (['document.draft'].includes(status)) return 'draft';
  if (['document.sent', 'document.viewed', 'document.waiting_approval', 'document.external_review'].includes(status)) return 'sentViewed';
  if (['document.completed', 'document.paid'].includes(status)) return 'completedSigned';
  return null;
};

const toNumberOrNull = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const getType = (v) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);
const getKeys = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v).slice(0, 10) : []);

const getTokenNames = (detail) => {
  const names = [];
  const push = (name) => {
    if (!name || names.length >= 10) return;
    names.push(String(name));
  };
  for (const pool of [detail?.tokens, detail?.variables]) {
    if (!pool) continue;
    if (Array.isArray(pool)) {
      for (const i of pool) { push(i?.name || i?.key); if (names.length >= 10) break; }
    } else if (typeof pool === 'object') {
      Object.keys(pool).slice(0, 10 - names.length).forEach(push);
    }
  }
  return names;
};

const getValueAndSource = (doc) => {
  const checkedValueFields = [
    'value',
    'grand_total', 'grand_total.amount', 'grand_total.value', 'grand_total.total',
    'pricing.grand_total', 'pricing.grand_total.amount', 'pricing.grand_total.value', 'pricing.grand_total.total',
    'pricing.totals.grand_total', 'pricing.totals.grand_total.amount', 'pricing.totals.grand_total.value', 'pricing.totals.grand_total.total',
    'tokens.Document.Value', 'variables.Document.Value',
  ];

  const candidates = [
    { source: 'value', value: doc?.value },
    { source: 'grand_total', value: doc?.grand_total },
    { source: 'grand_total.amount', value: doc?.grand_total?.amount },
    { source: 'grand_total.value', value: doc?.grand_total?.value },
    { source: 'grand_total.total', value: doc?.grand_total?.total },
    { source: 'pricing.grand_total', value: doc?.pricing?.grand_total },
    { source: 'pricing.grand_total.amount', value: doc?.pricing?.grand_total?.amount },
    { source: 'pricing.grand_total.value', value: doc?.pricing?.grand_total?.value },
    { source: 'pricing.grand_total.total', value: doc?.pricing?.grand_total?.total },
    { source: 'pricing.totals.grand_total', value: doc?.pricing?.totals?.grand_total },
    { source: 'pricing.totals.grand_total.amount', value: doc?.pricing?.totals?.grand_total?.amount },
    { source: 'pricing.totals.grand_total.value', value: doc?.pricing?.totals?.grand_total?.value },
    { source: 'pricing.totals.grand_total.total', value: doc?.pricing?.totals?.grand_total?.total },
  ];

  for (const c of candidates) {
    const n = toNumberOrNull(c.value);
    if (n !== null) return { value: n, valueSourceUsed: c.source, checkedValueFields };
  }

  for (const pool of [{ label: 'tokens', data: doc?.tokens }, { label: 'variables', data: doc?.variables }]) {
    const d = pool.data;
    if (!d) continue;
    if (Array.isArray(d)) {
      const token = d.find((t) => String(t?.name || t?.key || '').toLowerCase() === 'document.value');
      const n = toNumberOrNull(token?.value ?? token?.text ?? null);
      if (n !== null) return { value: n, valueSourceUsed: `${pool.label}.Document.Value`, checkedValueFields };
    } else if (typeof d === 'object') {
      const n = toNumberOrNull(d['Document.Value'] ?? d['document.value'] ?? null);
      if (n !== null) return { value: n, valueSourceUsed: `${pool.label}.Document.Value`, checkedValueFields };
    }
  }

  return { value: null, valueSourceUsed: 'none', checkedValueFields };
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

exports.main = async () => {
  let timedOut = false, detailSuccesses = 0, detailFailures = 0;
  try {
    const apiKey = process.env.PANDADOC_API_KEY;
    if (!apiKey) return { statusCode: 500, body: { message: 'Missing PANDADOC_API_KEY secret.' } };
    const headers = { Authorization: `API-Key ${apiKey}`, 'Content-Type': 'application/json' };

    const listResult = await fetchWithTimeout(`${PANDADOC_BASE_URL}/documents?count=${MAX_DOCUMENTS}`, { method: 'GET', headers }, LIST_TIMEOUT_MS);
    timedOut ||= listResult.timedOut;
    if (!listResult.response || !listResult.response.ok) return { statusCode: listResult.response ? 502 : 200, body: { documents: [], totals: { draft: 0, sentViewed: 0, completedSigned: 0, overall: 0 }, debug: { diagnosticMode: false, pandaDocMode: 'recent-documents-with-details-value-diagnostics', documentCount: 0, detailSuccesses, detailFailures, valueFoundCount: 0, valueMissingCount: 0, timedOut } } };

    const payload = await listResult.response.json();
    const listDocs = (payload?.results || payload?.documents || []).slice(0, MAX_DOCUMENTS);
    const settled = await Promise.allSettled(listDocs.map(async (doc) => {
      if (!doc?.id) { detailFailures += 1; return doc; }
      const detailResult = await fetchWithTimeout(`${PANDADOC_BASE_URL}/documents/${doc.id}/details`, { method: 'GET', headers }, DETAIL_TIMEOUT_MS);
      timedOut ||= detailResult.timedOut;
      if (!detailResult.response || !detailResult.response.ok) { detailFailures += 1; return doc; }
      try { detailSuccesses += 1; return { ...doc, ...(await detailResult.response.json()) }; } catch { detailFailures += 1; return doc; }
    }));

    const mergedDocs = settled.map((r, idx) => (r.status === 'fulfilled' ? r.value : listDocs[idx]));
    const documents = mergedDocs.map((doc) => {
      const { value, valueSourceUsed, checkedValueFields } = getValueAndSource(doc);
      return {
        id: doc?.id || null,
        name: doc?.name || null,
        status: doc?.status || null,
        value,
        currency: doc?.currency || doc?.pricing?.currency || null,
        createdAt: doc?.date_created || doc?.created_at || null,
        createdBy: normalizeCreatedBy(doc),
        url: doc?.link || buildDocUrl(doc?.id),
        debug: {
          valueSourceUsed, checkedValueFields,
          hasValueField: doc?.value !== undefined,
          hasGrandTotalField: doc?.grand_total !== undefined,
          hasPricingField: !!doc?.pricing,
          hasTokens: !!doc?.tokens,
          hasVariables: !!doc?.variables,
          tokenNamesSample: getTokenNames(doc),
          linkedObjectKeys: getKeys(doc?.linked_objects),
          metadataKeys: getKeys(doc?.metadata),
          grandTotalType: getType(doc?.grand_total),
          grandTotalKeys: getKeys(doc?.grand_total),
          grandTotalValueCandidates: {
            grand_total: toNumberOrNull(doc?.grand_total),
            grand_total_amount: toNumberOrNull(doc?.grand_total?.amount),
            grand_total_value: toNumberOrNull(doc?.grand_total?.value),
            grand_total_total: toNumberOrNull(doc?.grand_total?.total),
          },
          pricingType: getType(doc?.pricing),
          pricingKeys: getKeys(doc?.pricing),
          pricingGrandTotalType: getType(doc?.pricing?.grand_total),
          pricingGrandTotalKeys: getKeys(doc?.pricing?.grand_total),
          pricingTotalsType: getType(doc?.pricing?.totals),
          pricingTotalsKeys: getKeys(doc?.pricing?.totals),
          pricingTotalsGrandTotalType: getType(doc?.pricing?.totals?.grand_total),
          pricingTotalsGrandTotalKeys: getKeys(doc?.pricing?.totals?.grand_total),
        },
      };
    });

    const totals = documents.reduce((acc, doc) => {
      if (doc.value === null) return acc;
      acc.overall += doc.value;
      const g = mapStatusGroup(doc.status); if (g) acc[g] += doc.value;
      return acc;
    }, { draft: 0, sentViewed: 0, completedSigned: 0, overall: 0 });

    const valueFoundCount = documents.filter((d) => d.value !== null).length;
    return { statusCode: 200, body: { documents, totals, debug: { diagnosticMode: false, pandaDocMode: 'recent-documents-with-details-value-diagnostics', documentCount: documents.length, detailSuccesses, detailFailures, valueFoundCount, valueMissingCount: documents.length - valueFoundCount, timedOut } } };
  } catch (error) {
    return { statusCode: 502, body: { message: 'Unable to reach PandaDoc API.', error: error?.message || 'Unknown error', debug: { diagnosticMode: false, pandaDocMode: 'recent-documents-with-details-value-diagnostics', documentCount: 0, detailSuccesses, detailFailures, valueFoundCount: 0, valueMissingCount: 0, timedOut } } };
  }
};
