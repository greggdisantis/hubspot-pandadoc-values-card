import React, { useEffect, useMemo, useState } from 'react';
import {
  hubspot,
  Box,
  Divider,
  Flex,
  LoadingSpinner,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
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

        const normalized = normalizeServerlessPayload(response);
        setState({ loading: false, error: null, data: normalized });
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

  const totals = useMemo(() => {
    if (isRecord(state.data?.totals) && Object.keys(state.data.totals).length > 0) return state.data.totals;

    return documents.reduce(
      (acc, doc) => {
        const v = Number(doc?.value);
        const amount = Number.isFinite(v) ? v : 0;
        acc.overall += amount;
        if (STATUS_GROUPS.draft.has(doc?.status)) acc.draft += amount;
        if (STATUS_GROUPS.sentViewed.has(doc?.status)) acc.sentViewed += amount;
        if (STATUS_GROUPS.completedSigned.has(doc?.status)) acc.completedSigned += amount;
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

  if (!documents.length) return <Text>No PandaDoc documents found.</Text>;

  return (
    <Flex direction="column" gap="small">
      <Box>
        <Text>Draft total: {formatUsd(totals.draft)}</Text>
        <Text>Sent/viewed total: {formatUsd(totals.sentViewed)}</Text>
        <Text>Completed/signed total: {formatUsd(totals.completedSigned)}</Text>
        <Text>Overall total: {formatUsd(totals.overall)}</Text>
      </Box>
      <Divider />
      <Table compact>
        <TableHead>
          <TableRow>
            <TableHeader>Name</TableHeader>
            <TableHeader>Status</TableHeader>
            <TableHeader>Value</TableHeader>
            <TableHeader>Created</TableHeader>
            <TableHeader>Owner</TableHeader>
          </TableRow>
        </TableHead>
        <TableBody>
          {documents.map((doc) => (
            <TableRow key={String(doc?.id || doc?.name || Math.random())}>
              <TableCell>{doc?.name || '—'}</TableCell>
              <TableCell>{doc?.status || '—'}</TableCell>
              <TableCell>{formatUsd(doc?.value)}</TableCell>
              <TableCell>{formatDate(doc?.createdAt)}</TableCell>
              <TableCell>{doc?.createdBy || '—'}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Flex>
  );
}
