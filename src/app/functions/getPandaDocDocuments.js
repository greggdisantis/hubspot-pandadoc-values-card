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

const getTokenNames = (detail) => {
  const names = [];
  const push = (name) => {
    if (!name) return;
    if (names.length >= 10) return;
    names.push(String(name));
  };

  const pools = [detail?.tokens, detail?.variables];
  for (const pool of pools) {
    if (!pool) continue;
    if (Array.isArray(pool)) {
      for (const item of pool) {
        push(item?.name || item?.key);
        if (names.length >= 10) break;
      }
    } else if (typeof pool === 'object') {
      Object.keys(pool).slice(0, 10 - names.length).forEach(push);
    }
    if (names.length >= 10) break;
  }

  return names;
};

const getValueAndSource = (doc) => {
  const checkedValueFields = ['value', 'grand_total', 'pricing.grand_total', 'pricing.totals.grand_total', 'tokens.Document.Value', 'variables.Document.Value'];

  const candidates = [
    { source: 'value', value: doc?.value },
    { source: 'grand_total', value: doc?.grand_total },
    { source: 'pricing.grand_total', value: doc?.pricing?.grand_total },
    { source: 'pricing.totals.grand_total', value: doc?.pricing?.totals?.grand_total },
  ];

  for (const c of candidates) {
    const numeric = toNumberOrNull(c.value);
    if (numeric !== null) {
      return { value: numeric, valueSourceUsed: c.source, checkedValueFields };
    }
  }

  const pools = [
    { label: 'tokens', data: doc?.tokens },
    { label: 'variables', data: doc?.variables },
  ];

  for (const pool of pools) {
    const data = pool.data;
    if (!data) continue;

    if (Array.isArray(data)) {
      const token = data.find((t) => String(t?.name || t?.key || '').toLowerCase() === 'document.value');
      const numeric = toNumberOrNull(token?.value ?? token?.text ?? null);
      if (numeric !== null) return { value: numeric, valueSourceUsed: `${pool.label}.Document.Value`, checkedValueFields };
    } else if (typeof data === 'object') {
      const raw = data['Document.Value'] ?? data['document.value'] ?? null;
      const numeric = toNumberOrNull(raw);
      if (numeric !== null) return { value: numeric, valueSourceUsed: `${pool.label}.Document.Value`, checkedValueFields };
    }
  }

  return { value: null, valueSourceUsed: 'none', checkedValueFields };
};

const normalizeCreatedBy = (doc) => {
  if (doc?.owner?.email) return doc.owner.email;
  if (doc?.owner?.first_name || doc?.owner?.last_name) return `${doc.owner.first_name || ''} ${doc.owner.last_name || ''}`.trim();
  if (doc?.created_by?.email) return doc.created_by.email;
  return null;
};

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
  } finally {
    clearTimeout(timer);
  }
};

exports.main = async () => {
  let timedOut = false;
  let detailSuccesses = 0;
  let detailFailures = 0;

  try {
    const apiKey = process.env.PANDADOC_API_KEY;
    if (!apiKey) return { statusCode: 500, body: { message: 'Missing PANDADOC_API_KEY secret.' } };

    const headers = {
      Authorization: `API-Key ${apiKey}`,
      'Content-Type': 'application/json',
    };

    const listResult = await fetchWithTimeout(`${PANDADOC_BASE_URL}/documents?count=${MAX_DOCUMENTS}`, { method: 'GET', headers }, LIST_TIMEOUT_MS);
    timedOut = timedOut || listResult.timedOut;

    if (!listResult.response || !listResult.response.ok) {
      return {
        statusCode: listResult.response ? 502 : 200,
        body: {
          documents: [],
          totals: { draft: 0, sentViewed: 0, completedSigned: 0, overall: 0 },
          debug: {
            diagnosticMode: false,
            pandaDocMode: 'recent-documents-with-details-value-diagnostics',
            documentCount: 0,
            detailSuccesses,
            detailFailures,
            valueFoundCount: 0,
            valueMissingCount: 0,
            timedOut,
          },
        },
      };
    }

    const payload = await listResult.response.json();
    const listDocs = (payload?.results || payload?.documents || []).slice(0, MAX_DOCUMENTS);

    const settled = await Promise.allSettled(
      listDocs.map(async (doc) => {
        if (!doc?.id) {
          detailFailures += 1;
          return doc;
        }
        const detailResult = await fetchWithTimeout(`${PANDADOC_BASE_URL}/documents/${doc.id}/details`, { method: 'GET', headers }, DETAIL_TIMEOUT_MS);
        timedOut = timedOut || detailResult.timedOut;
        if (!detailResult.response || !detailResult.response.ok) {
          detailFailures += 1;
          return doc;
        }
        try {
          const detail = await detailResult.response.json();
          detailSuccesses += 1;
          return { ...doc, ...detail };
        } catch {
          detailFailures += 1;
          return doc;
        }
      }),
    );

    const mergedDocs = settled.map((r, idx) => (r.status === 'fulfilled' ? r.value : listDocs[idx]));

    const documents = mergedDocs.map((doc) => {
      const { value, valueSourceUsed, checkedValueFields } = getValueAndSource(doc);
      const tokenNamesSample = getTokenNames(doc);
      const linkedObjectKeys = doc?.linked_objects && typeof doc.linked_objects === 'object' ? Object.keys(doc.linked_objects).slice(0, 10) : [];
      const metadataKeys = doc?.metadata && typeof doc.metadata === 'object' ? Object.keys(doc.metadata).slice(0, 10) : [];

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
          valueSourceUsed,
          checkedValueFields,
          hasValueField: doc?.value !== undefined,
          hasGrandTotalField: doc?.grand_total !== undefined,
          hasPricingField: !!doc?.pricing,
          hasTokens: !!doc?.tokens,
          hasVariables: !!doc?.variables,
          tokenNamesSample,
          linkedObjectKeys,
          metadataKeys,
        },
      };
    });

    const totals = documents.reduce(
      (acc, doc) => {
        if (doc.value === null) return acc;
        acc.overall += doc.value;
        const group = mapStatusGroup(doc.status);
        if (group) acc[group] += doc.value;
        return acc;
      },
      { draft: 0, sentViewed: 0, completedSigned: 0, overall: 0 },
    );

    const valueFoundCount = documents.filter((d) => d.value !== null).length;
    const valueMissingCount = documents.length - valueFoundCount;

    return {
      statusCode: 200,
      body: {
        documents,
        totals,
        debug: {
          diagnosticMode: false,
          pandaDocMode: 'recent-documents-with-details-value-diagnostics',
          documentCount: documents.length,
          detailSuccesses,
          detailFailures,
          valueFoundCount,
          valueMissingCount,
          timedOut,
        },
      },
    };
  } catch (error) {
    return {
      statusCode: 502,
      body: {
        message: 'Unable to reach PandaDoc API.',
        error: error?.message || 'Unknown error',
        debug: {
          diagnosticMode: false,
          pandaDocMode: 'recent-documents-with-details-value-diagnostics',
          documentCount: 0,
          detailSuccesses,
          detailFailures,
          valueFoundCount: 0,
          valueMissingCount: 0,
          timedOut,
        },
      },
    };
  }
};
