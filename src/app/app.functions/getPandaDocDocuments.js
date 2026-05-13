const PANDADOC_BASE_URL = 'https://api.pandadoc.com/public/v1';

const mapStatusGroup = (status) => {
  if (['document.draft'].includes(status)) return 'draft';
  if (['document.sent', 'document.viewed', 'document.waiting_approval', 'document.external_review'].includes(status)) return 'sentViewed';
  if (['document.completed', 'document.paid'].includes(status)) return 'completedSigned';
  return null;
};

const normalizeValue = (doc) => {
  // PandaDoc usually exposes monetary total as `value` on document details/list payloads.
  // Defensive fallbacks cover nested `pricing` structures if returned by account-specific payload variants.
  const raw = doc?.value ?? doc?.pricing?.grand_total ?? doc?.pricing?.totals?.grand_total ?? null;
  const numeric = raw === null || raw === undefined ? null : Number(raw);
  return Number.isFinite(numeric) ? numeric : null;
};

const normalizeCurrency = (doc) => {
  return doc?.currency || doc?.pricing?.currency || null;
};

const normalizeCreatedBy = (doc) => {
  if (doc?.owner?.email) return doc.owner.email;
  if (doc?.owner?.first_name || doc?.owner?.last_name) return `${doc.owner.first_name || ''} ${doc.owner.last_name || ''}`.trim();
  if (doc?.created_by?.email) return doc.created_by.email;
  return null;
};

const buildDocUrl = (docId) => (docId ? `https://app.pandadoc.com/a/#/documents/${docId}` : null);

exports.main = async (context = {}) => {
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

    // Preferred strategy: filter by dedicated metadata/linked values containing HubSpot deal id.
    const searchQueries = [
      `${PANDADOC_BASE_URL}/documents?metadata.hubspot_deal_id=${encodeURIComponent(dealId)}`,
      `${PANDADOC_BASE_URL}/documents?metadata.hs_object_id=${encodeURIComponent(dealId)}`,
      `${PANDADOC_BASE_URL}/documents?tag=${encodeURIComponent(`hubspot-deal-${dealId}`)}`,
      // Last resort fallback: textual query (not recommended for permanent matching).
      `${PANDADOC_BASE_URL}/documents?q=${encodeURIComponent(dealId)}`,
    ];

    const collected = new Map();
    for (const url of searchQueries) {
      const res = await fetch(url, { method: 'GET', headers });
      if (!res.ok) continue;
      const payload = await res.json();
      const docs = payload?.results || payload?.documents || [];
      docs.forEach((d) => {
        if (d?.id) collected.set(d.id, d);
      });
      if (collected.size > 0 && !url.includes('/documents?q=')) break;
    }

    const enriched = [];
    for (const partial of collected.values()) {
      const detailRes = await fetch(`${PANDADOC_BASE_URL}/documents/${partial.id}/details`, { method: 'GET', headers });
      const detail = detailRes.ok ? await detailRes.json() : partial;
      const value = normalizeValue(detail);
      enriched.push({
        id: detail.id,
        name: detail.name || partial.name || detail.id,
        status: detail.status || partial.status || 'unknown',
        value,
        currency: normalizeCurrency(detail),
        createdAt: detail.date_created || detail.created_at || null,
        createdBy: normalizeCreatedBy(detail),
        url: detail?.link || buildDocUrl(detail.id),
      });
    }

    const totals = enriched.reduce(
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
        documents: enriched,
        totals,
      },
    };
  } catch (error) {
    return {
      statusCode: 502,
      body: {
        message: 'Unable to reach PandaDoc API.',
        error: error?.message || 'Unknown error',
      },
    };
  }
};
