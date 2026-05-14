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

const getDocumentValueFromTokens = (detail) => {
  const pools = [detail?.tokens, detail?.variables];
  for (const pool of pools) {
    if (!pool) continue;
    if (Array.isArray(pool)) {
      const token = pool.find((t) => String(t?.name || t?.key || '').toLowerCase() === 'document.value');
      const candidate = token?.value ?? token?.text ?? null;
      const numeric = toNumberOrNull(candidate);
      if (numeric !== null) return numeric;
    } else if (typeof pool === 'object') {
      const direct = pool['Document.Value'] ?? pool['document.value'] ?? null;
      const numeric = toNumberOrNull(direct);
      if (numeric !== null) return numeric;
    }
  }
  return null;
};

const normalizeValue = (doc) => {
  const candidates = [
    doc?.value,
    doc?.grand_total,
    doc?.pricing?.grand_total,
    doc?.pricing?.totals?.grand_total,
  ];

  for (const c of candidates) {
    const numeric = toNumberOrNull(c);
    if (numeric !== null) return numeric;
  }

  return getDocumentValueFromTokens(doc);
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

    const listResult = await fetchWithTimeout(
      `${PANDADOC_BASE_URL}/documents?count=${MAX_DOCUMENTS}`,
      { method: 'GET', headers },
      LIST_TIMEOUT_MS,
    );

    timedOut = timedOut || listResult.timedOut;

    if (!listResult.response) {
      return {
        statusCode: 200,
        body: {
          documents: [],
          totals: { draft: 0, sentViewed: 0, completedSigned: 0, overall: 0 },
          debug: {
            diagnosticMode: false,
            pandaDocMode: 'recent-documents-with-details',
            documentCount: 0,
            detailSuccesses,
            detailFailures,
            timedOut: true,
          },
        },
      };
    }

    if (!listResult.response.ok) {
      return {
        statusCode: 502,
        body: {
          message: 'PandaDoc list request failed.',
          status: listResult.response.status,
          debug: { diagnosticMode: false, pandaDocMode: 'recent-documents-with-details', documentCount: 0, detailSuccesses, detailFailures, timedOut },
        },
      };
    }

    const payload = await listResult.response.json();
    const listDocs = (payload?.results || payload?.documents || []).slice(0, MAX_DOCUMENTS);

    const detailTasks = listDocs.map(async (doc) => {
      if (!doc?.id) {
        detailFailures += 1;
        return doc;
      }

      const detailResult = await fetchWithTimeout(
        `${PANDADOC_BASE_URL}/documents/${doc.id}/details`,
        { method: 'GET', headers },
        DETAIL_TIMEOUT_MS,
      );

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
    });

    const settled = await Promise.allSettled(detailTasks);
    const mergedDocs = settled.map((r, idx) => {
      if (r.status === 'fulfilled') return r.value;
      detailFailures += 1;
      return listDocs[idx];
    });

    const documents = mergedDocs.map((doc) => ({
      id: doc?.id || null,
      name: doc?.name || null,
      status: doc?.status || null,
      value: normalizeValue(doc),
      currency: doc?.currency || doc?.pricing?.currency || null,
      createdAt: doc?.date_created || doc?.created_at || null,
      createdBy: normalizeCreatedBy(doc),
      url: doc?.link || buildDocUrl(doc?.id),
    }));

    const totals = documents.reduce(
      (acc, doc) => {
        const amount = toNumberOrNull(doc.value);
        if (amount === null) return acc;
        acc.overall += amount;
        const group = mapStatusGroup(doc.status);
        if (group) acc[group] += amount;
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
          diagnosticMode: false,
          pandaDocMode: 'recent-documents-with-details',
          documentCount: documents.length,
          detailSuccesses,
          detailFailures,
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
          pandaDocMode: 'recent-documents-with-details',
          documentCount: 0,
          detailSuccesses,
          detailFailures,
          timedOut,
        },
      },
    };
  }
};
