const PANDADOC_BASE_URL = 'https://api.pandadoc.com/public/v1';
const LIST_TIMEOUT_MS = 8000;
const DETAIL_TIMEOUT_MS = 5000;
const MAX_DOCUMENTS = 50;
const MATCH_FIELDS_CHECKED = ['metadata.hubspot.deal_id', 'Deal.DealID', 'Deal.HsObjectId', 'Deal.PandaDocMirrorJobId'];

const mapStatusGroup = (status) => {
  if (['document.draft'].includes(status)) return 'draft';
  if (['document.sent', 'document.viewed', 'document.waiting_approval', 'document.external_review'].includes(status)) return 'sentViewed';
  if (['document.completed', 'document.paid'].includes(status)) return 'completedSigned';
  return null;
};

const toNumberOrNull = (value) => {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const cleaned = String(value).replace(/[$,\s]/g, '');
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
};

const getTokenVariableValue = (doc, keyName) => {
  const keyLc = String(keyName).toLowerCase();
  for (const pool of [doc?.tokens, doc?.variables]) {
    if (!pool) continue;
    if (Array.isArray(pool)) {
      const hit = pool.find((t) => String(t?.name || t?.key || '').toLowerCase() === keyLc);
      if (hit) return hit?.value ?? hit?.text ?? null;
    } else if (typeof pool === 'object') {
      for (const [k, v] of Object.entries(pool)) {
        if (String(k).toLowerCase() === keyLc) return v;
      }
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
const normStr = (v) => String(v ?? '').trim();

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

exports.main = async (context = {}) => {
  let timedOut = false;
  let detailSuccesses = 0;
  let detailFailures = 0;

  try {
    const dealId = normStr(context?.parameters?.dealId);
    if (!dealId) return { statusCode: 400, body: { message: 'dealId is required.' } };

    const apiKey = process.env.PANDADOC_API_KEY;
    if (!apiKey) return { statusCode: 500, body: { message: 'Missing PANDADOC_API_KEY secret.' } };

    const headers = { Authorization: `API-Key ${apiKey}`, 'Content-Type': 'application/json' };
    const listUrl = `${PANDADOC_BASE_URL}/documents?count=${MAX_DOCUMENTS}`;
    const listResult = await fetchWithTimeout(listUrl, { method: 'GET', headers }, LIST_TIMEOUT_MS);
    timedOut ||= listResult.timedOut;

    if (!listResult.response || !listResult.response.ok) {
      return {
        statusCode: listResult.response ? 502 : 200,
        body: {
          documents: [],
          totals: { draft: 0, sentViewed: 0, completedSigned: 0, overall: 0 },
          debug: {
            pandaDocMode: 'manual-token-or-metadata-match',
            scannedDocumentCount: 0,
            matchedDocumentCount: 0,
            detailSuccesses,
            detailFailures,
            timedOut,
            matchFieldsChecked: MATCH_FIELDS_CHECKED,
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
        timedOut ||= detailResult.timedOut;
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

    const scannedDocs = settled.map((r, idx) => (r.status === 'fulfilled' ? r.value : listDocs[idx]));

    const matchedDocs = scannedDocs.filter((doc) => {
      const byMetadata = normStr(doc?.metadata?.['hubspot.deal_id']) === dealId;
      const byDealId = normStr(getTokenVariableValue(doc, 'Deal.DealID')) === dealId;
      const byHsId = normStr(getTokenVariableValue(doc, 'Deal.HsObjectId')) === dealId;
      const byMirrorId = normStr(getTokenVariableValue(doc, 'Deal.PandaDocMirrorJobId')) === dealId;
      return byMetadata || byDealId || byHsId || byMirrorId;
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

    return {
      statusCode: 200,
      body: {
        documents,
        totals,
        debug: {
          pandaDocMode: 'manual-token-or-metadata-match',
          scannedDocumentCount: scannedDocs.length,
          matchedDocumentCount: documents.length,
          detailSuccesses,
          detailFailures,
          timedOut,
          matchFieldsChecked: MATCH_FIELDS_CHECKED,
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
          pandaDocMode: 'manual-token-or-metadata-match',
          scannedDocumentCount: 0,
          matchedDocumentCount: 0,
          detailSuccesses,
          detailFailures,
          timedOut,
          matchFieldsChecked: MATCH_FIELDS_CHECKED,
        },
      },
    };
  }
};
