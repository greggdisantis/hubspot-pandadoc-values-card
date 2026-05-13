const PANDADOC_BASE_URL = 'https://api.pandadoc.com/public/v1';
const SEARCH_PAGE_SIZE = 10;
const MAX_DETAILS = 10;
const FETCH_TIMEOUT_MS = 3500;
const TOTAL_BUDGET_MS = 14500;

const mapStatusGroup = (status) => {
  if (['document.draft'].includes(status)) return 'draft';
  if (['document.sent', 'document.viewed', 'document.waiting_approval', 'document.external_review'].includes(status)) return 'sentViewed';
  if (['document.completed', 'document.paid'].includes(status)) return 'completedSigned';
  return null;
};

const normalizeValue = (doc) => {
  const raw = doc?.value ?? doc?.pricing?.grand_total ?? doc?.pricing?.totals?.grand_total ?? null;
  const numeric = raw === null || raw === undefined ? null : Number(raw);
  return Number.isFinite(numeric) ? numeric : null;
};

const normalizeCurrency = (doc) => doc?.currency || doc?.pricing?.currency || null;

const normalizeCreatedBy = (doc) => {
  if (doc?.owner?.email) return doc.owner.email;
  if (doc?.owner?.first_name || doc?.owner?.last_name) return `${doc.owner.first_name || ''} ${doc.owner.last_name || ''}`.trim();
  if (doc?.created_by?.email) return doc.created_by.email;
  return null;
};

const buildDocUrl = (docId) => (docId ? `https://app.pandadoc.com/a/#/documents/${docId}` : null);

const withTimeoutFetch = async (url, options, timeoutMs) => {
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
  const startedAt = Date.now();
  let timedOut = false;

  try {
    const dealId = context?.parameters?.dealId;
    if (!dealId) {
      return { statusCode: 400, body: { message: 'dealId is required.' } };
    }

    const apiKey = process.env.PANDADOC_API_KEY;
    if (!apiKey) {
      return { statusCode: 500, body: { message: 'Missing PANDADOC_API_KEY secret.' } };
    }

    const headers = {
      Authorization: `API-Key ${apiKey}`,
      'Content-Type': 'application/json',
    };

    const searchPlans = [
      { name: 'metadata.hubspot_deal_id', url: `${PANDADOC_BASE_URL}/documents?metadata.hubspot_deal_id=${encodeURIComponent(dealId)}&count=${SEARCH_PAGE_SIZE}` },
      { name: 'metadata.hs_object_id', url: `${PANDADOC_BASE_URL}/documents?metadata.hs_object_id=${encodeURIComponent(dealId)}&count=${SEARCH_PAGE_SIZE}` },
      { name: 'tag', url: `${PANDADOC_BASE_URL}/documents?tag=${encodeURIComponent(`hubspot-deal-${dealId}`)}&count=${SEARCH_PAGE_SIZE}` },
    ];

    const collected = new Map();
    let matchStrategyUsed = 'none';

    for (const plan of searchPlans) {
      if (Date.now() - startedAt > TOTAL_BUDGET_MS - 5000) {
        timedOut = true;
        break;
      }

      const { response, timedOut: searchTimedOut } = await withTimeoutFetch(plan.url, { method: 'GET', headers }, FETCH_TIMEOUT_MS);
      timedOut = timedOut || searchTimedOut;
      if (!response || !response.ok) continue;

      const payload = await response.json();
      const docs = (payload?.results || payload?.documents || []).slice(0, SEARCH_PAGE_SIZE);
      docs.forEach((d) => d?.id && collected.set(d.id, d));

      if (collected.size > 0) {
        matchStrategyUsed = plan.name;
        break;
      }
    }

    if (collected.size === 0 && Date.now() - startedAt <= TOTAL_BUDGET_MS - 5000) {
      const fallbackUrl = `${PANDADOC_BASE_URL}/documents?q=${encodeURIComponent(dealId)}&count=${SEARCH_PAGE_SIZE}`;
      const { response, timedOut: fallbackTimedOut } = await withTimeoutFetch(fallbackUrl, { method: 'GET', headers }, FETCH_TIMEOUT_MS);
      timedOut = timedOut || fallbackTimedOut;
      if (response && response.ok) {
        const payload = await response.json();
        const docs = (payload?.results || payload?.documents || []).slice(0, SEARCH_PAGE_SIZE);
        docs.forEach((d) => d?.id && collected.set(d.id, d));
        if (collected.size > 0) matchStrategyUsed = 'fallback.q';
      }
    }

    const seedDocs = Array.from(collected.values()).slice(0, MAX_DETAILS);
    let detailFailures = 0;

    const detailPromises = seedDocs.map(async (partial) => {
      if (Date.now() - startedAt > TOTAL_BUDGET_MS - 1500) {
        timedOut = true;
        return partial;
      }

      const { response, timedOut: detailTimedOut } = await withTimeoutFetch(
        `${PANDADOC_BASE_URL}/documents/${partial.id}/details`,
        { method: 'GET', headers },
        FETCH_TIMEOUT_MS,
      );
      timedOut = timedOut || detailTimedOut;
      if (!response || !response.ok) {
        detailFailures += 1;
        return partial;
      }

      try {
        return await response.json();
      } catch {
        detailFailures += 1;
        return partial;
      }
    });

    const details = await Promise.all(detailPromises);
    const documents = details.map((detail, i) => {
      const partial = seedDocs[i] || {};
      return {
        id: detail.id || partial.id,
        name: detail.name || partial.name || detail.id || partial.id,
        status: detail.status || partial.status || 'unknown',
        value: normalizeValue(detail),
        currency: normalizeCurrency(detail),
        createdAt: detail.date_created || detail.created_at || partial.date_created || null,
        createdBy: normalizeCreatedBy(detail) || normalizeCreatedBy(partial),
        url: detail?.link || partial?.link || buildDocUrl(detail.id || partial.id),
      };
    });

    const totals = documents.reduce(
      (acc, doc) => {
        const amount = Number(doc.value) || 0;
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
          matchStrategyUsed,
          documentCount: documents.length,
          detailFailures,
          timedOut: timedOut || Date.now() - startedAt >= TOTAL_BUDGET_MS,
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
          matchStrategyUsed: 'error',
          documentCount: 0,
          detailFailures: 0,
          timedOut,
        },
      },
    };
  }
};
