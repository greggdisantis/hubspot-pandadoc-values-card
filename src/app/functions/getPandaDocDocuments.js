const PANDADOC_BASE_URL = 'https://api.pandadoc.com/public/v1';
const REQUEST_TIMEOUT_MS = 8000;
const MAX_DOCUMENTS = 5;

const normalizeValue = (doc) => {
  const raw = doc?.value ?? null;
  if (raw === null || raw === undefined) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
};

const normalizeCreatedBy = (doc) => {
  if (doc?.owner?.email) return doc.owner.email;
  if (doc?.owner?.first_name || doc?.owner?.last_name) {
    return `${doc.owner.first_name || ''} ${doc.owner.last_name || ''}`.trim();
  }
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

  try {
    const apiKey = process.env.PANDADOC_API_KEY;
    if (!apiKey) {
      return { statusCode: 500, body: { message: 'Missing PANDADOC_API_KEY secret.' } };
    }

    const { response, timedOut: requestTimedOut } = await fetchWithTimeout(
      `${PANDADOC_BASE_URL}/documents?count=${MAX_DOCUMENTS}`,
      {
        method: 'GET',
        headers: {
          Authorization: `API-Key ${apiKey}`,
          'Content-Type': 'application/json',
        },
      },
      REQUEST_TIMEOUT_MS,
    );

    timedOut = requestTimedOut;

    if (!response) {
      return {
        statusCode: 200,
        body: {
          documents: [],
          totals: { draft: 0, sentViewed: 0, completedSigned: 0, overall: 0 },
          debug: {
            diagnosticMode: false,
            pandaDocMode: 'recent-documents-list-only',
            documentCount: 0,
            timedOut: true,
          },
        },
      };
    }

    if (!response.ok) {
      return {
        statusCode: 502,
        body: {
          message: 'PandaDoc list request failed.',
          status: response.status,
          debug: {
            diagnosticMode: false,
            pandaDocMode: 'recent-documents-list-only',
            documentCount: 0,
            timedOut,
          },
        },
      };
    }

    const payload = await response.json();
    const docs = (payload?.results || payload?.documents || []).slice(0, MAX_DOCUMENTS);

    const documents = docs.map((doc) => ({
      id: doc?.id || null,
      name: doc?.name || null,
      status: doc?.status || null,
      value: normalizeValue(doc),
      currency: doc?.currency || null,
      createdAt: doc?.date_created || doc?.created_at || null,
      createdBy: normalizeCreatedBy(doc),
      url: doc?.link || buildDocUrl(doc?.id),
    }));

    const totals = documents.reduce(
      (acc, doc) => {
        const amount = Number(doc.value);
        acc.overall += Number.isFinite(amount) ? amount : 0;
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
          pandaDocMode: 'recent-documents-list-only',
          documentCount: documents.length,
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
          pandaDocMode: 'recent-documents-list-only',
          documentCount: 0,
          timedOut,
        },
      },
    };
  }
};
