import React, { useEffect, useMemo, useState } from 'react';
import {
  hubspot,
  Box,
  Divider,
  Flex,
  LoadingSpinner,
  Text,
} from '@hubspot/ui-extensions';

const STATUS_GROUPS = {
  draft: new Set(['document.draft']),
  sentViewed: new Set(['document.sent', 'document.viewed', 'document.waiting_approval', 'document.external_review']),
  completedSigned: new Set(['document.completed', 'document.paid']),
};

const emptyPayload = { documents: [], totals: {}, debug: {} };
const isRecord = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

const normalizeServerlessPayload = (raw) => {
  try {
    const payload = raw?.response?.body ?? raw?.response ?? raw?.body ?? raw ?? {};
    const safePayload = isRecord(payload) ? payload : {};
    return {
      documents: Array.isArray(safePayload.documents) ? safePayload.documents : [],
      totals: isRecord(safePayload.totals) ? safePayload.totals : {},
      debug: isRecord(safePayload.debug) ? safePayload.debug : {},
    };
  } catch {
    return emptyPayload;
  }
};

const formatUsd = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(numeric);
};

const formatDate = (value) => {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US');
};

const formatList = (v) => (Array.isArray(v) ? (v.length ? v.join(', ') : '[]') : '[]');

hubspot.extend(({ context, runServerlessFunction }) => <PandaDocDocumentValuesCard context={context} runServerlessFunction={runServerlessFunction} />);

function PandaDocDocumentValuesCard({ context, runServerlessFunction }) {
  const dealId = context?.crm?.objectId || context?.crm?.properties?.hs_object_id;
  const [state, setState] = useState({ loading: true, error: null, data: emptyPayload });

  useEffect(() => {
    let isMounted = true;

    const load = async () => {
      if (!dealId) {
        if (isMounted) setState({ loading: false, error: 'No HubSpot Deal ID found in context.', data: emptyPayload });
        return;
      }

      setState({ loading: true, error: null, data: emptyPayload });

      try {
        const response = await runServerlessFunction({
          name: 'getPandaDocDocuments',
          parameters: { dealId: String(dealId) },
        });

        if (!isMounted) return;

        if (response?.status === 'ERROR') {
          setState({ loading: false, error: response?.message || 'Unable to load serverless response.', data: emptyPayload });
          return;
        }

        setState({ loading: false, error: null, data: normalizeServerlessPayload(response) });
      } catch {
        if (!isMounted) return;
        setState({ loading: false, error: 'Card failed to parse serverless response.', data: emptyPayload });
      }
    };

    load();
    return () => {
      isMounted = false;
    };
  }, [dealId, runServerlessFunction]);

  const documents = Array.isArray(state.data?.documents) ? state.data.documents : [];
  const topDebug = isRecord(state.data?.debug) ? state.data.debug : {};

  const totals = useMemo(() => {
    if (isRecord(state.data?.totals) && Object.keys(state.data.totals).length > 0) return state.data.totals;
    return documents.reduce(
      (acc, doc) => {
        const v = Number(doc?.value);
        if (!Number.isFinite(v)) return acc;
        acc.overall += v;
        if (STATUS_GROUPS.draft.has(doc?.status)) acc.draft += v;
        if (STATUS_GROUPS.sentViewed.has(doc?.status)) acc.sentViewed += v;
        if (STATUS_GROUPS.completedSigned.has(doc?.status)) acc.completedSigned += v;
        return acc;
      },
      { draft: 0, sentViewed: 0, completedSigned: 0, overall: 0 },
    );
  }, [documents, state.data]);

  if (state.loading) {
    return (
      <Flex direction="column" gap="small" align="center">
        <LoadingSpinner label="Loading PandaDoc documents" />
        <Text>Loading PandaDoc documents…</Text>
      </Flex>
    );
  }

  if (state.error) {
    return (
      <Box>
        <Text>Error: {state.error}</Text>
      </Box>
    );
  }

  return (
    <Flex direction="column" gap="small">
      <Box>
        <Text>Draft total: {formatUsd(totals.draft)}</Text>
        <Text>Sent/viewed total: {formatUsd(totals.sentViewed)}</Text>
        <Text>Completed/signed total: {formatUsd(totals.completedSigned)}</Text>
        <Text>Overall total: {formatUsd(totals.overall)}</Text>
      </Box>

      <Box>
        <Text>Debug mode: {String(topDebug.pandaDocMode || '—')}</Text>
        <Text>Debug documentCount: {String(topDebug.documentCount ?? '—')}</Text>
        <Text>Debug detailSuccesses: {String(topDebug.detailSuccesses ?? '—')}</Text>
        <Text>Debug detailFailures: {String(topDebug.detailFailures ?? '—')}</Text>
        <Text>Debug valueFoundCount: {String(topDebug.valueFoundCount ?? '—')}</Text>
        <Text>Debug valueMissingCount: {String(topDebug.valueMissingCount ?? '—')}</Text>
        <Text>Debug timedOut: {String(topDebug.timedOut ?? '—')}</Text>
      </Box>

      <Divider />

      {!documents.length ? (
        <Text>No PandaDoc documents found.</Text>
      ) : (
        <Flex direction="column" gap="xs">
          {documents.map((doc) => {
            const d = isRecord(doc?.debug) ? doc.debug : {};
            return (
              <Box key={String(doc?.id || doc?.name || 'doc')}>
                <Text>{doc?.name || '—'}</Text>
                <Text>Status: {doc?.status || '—'}</Text>
                <Text>Value: {formatUsd(doc?.value)}</Text>
                <Text>Created: {formatDate(doc?.createdAt)}</Text>
                <Text>Owner: {doc?.createdBy || '—'}</Text>
                <Text>Debug valueSourceUsed: {String(d.valueSourceUsed || '—')}</Text>
                <Text>Debug checkedValueFields: {formatList(d.checkedValueFields)}</Text>
                <Text>Debug hasValueField: {String(d.hasValueField ?? '—')}</Text>
                <Text>Debug hasGrandTotalField: {String(d.hasGrandTotalField ?? '—')}</Text>
                <Text>Debug hasPricingField: {String(d.hasPricingField ?? '—')}</Text>
                <Text>Debug hasTokens: {String(d.hasTokens ?? '—')}</Text>
                <Text>Debug hasVariables: {String(d.hasVariables ?? '—')}</Text>
                <Text>Debug tokenNamesSample: {formatList(d.tokenNamesSample)}</Text>
                <Text>Debug linkedObjectKeys: {formatList(d.linkedObjectKeys)}</Text>
                <Text>Debug metadataKeys: {formatList(d.metadataKeys)}</Text>
                <Text>Debug grandTotalType: {String(d.grandTotalType || '—')}</Text>
                <Text>Debug grandTotalKeys: {formatList(d.grandTotalKeys)}</Text>
                <Text>Debug grandTotalValueCandidates: {JSON.stringify(d.grandTotalValueCandidates || {})}</Text>
                <Text>Debug pricingType: {String(d.pricingType || '—')}</Text>
                <Text>Debug pricingKeys: {formatList(d.pricingKeys)}</Text>
                <Text>Debug pricingGrandTotalType: {String(d.pricingGrandTotalType || '—')}</Text>
                <Text>Debug pricingGrandTotalKeys: {formatList(d.pricingGrandTotalKeys)}</Text>
                <Text>Debug pricingTotalsType: {String(d.pricingTotalsType || '—')}</Text>
                <Text>Debug pricingTotalsKeys: {formatList(d.pricingTotalsKeys)}</Text>
                <Text>Debug pricingTotalsGrandTotalType: {String(d.pricingTotalsGrandTotalType || '—')}</Text>
                <Text>Debug pricingTotalsGrandTotalKeys: {formatList(d.pricingTotalsGrandTotalKeys)}</Text>
              </Box>
            );
          })}
        </Flex>
      )}
    </Flex>
  );
}
