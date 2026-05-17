import React, { useEffect, useMemo, useState } from 'react';
import {
  hubspot,
  Box,
  Button,
  Divider,
  Flex,
  Link,
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

const formatUsd = (value) => {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(Number(value));
};

const formatDate = (value) => {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US');
};

hubspot.extend(({ context, runServerlessFunction }) => (
  <PandaDocDocumentValuesCard context={context} runServerlessFunction={runServerlessFunction} />
));

function PandaDocDocumentValuesCard({ context, runServerlessFunction }) {
  const dealId = context?.crm?.objectId || context?.crm?.properties?.hs_object_id;
  const [state, setState] = useState({ loading: true, error: null, data: null });

  useEffect(() => {
    let isMounted = true;

    const load = async () => {
      if (!dealId) {
        if (isMounted) setState({ loading: false, error: 'No HubSpot Deal ID found in context.', data: null });
        return;
      }

      setState({ loading: true, error: null, data: null });
      const response = await runServerlessFunction({
        name: 'getPandaDocDocuments',
        parameters: { dealId: String(dealId) },
      });

      if (!isMounted) return;

      if (response.status === 'ERROR') {
        setState({ loading: false, error: response?.message || 'Unable to reach PandaDoc.', data: null });
      } else {
        setState({ loading: false, error: null, data: response.response });
      }
    };

    load();
    return () => { isMounted = false; };
  }, [dealId, runServerlessFunction]);

  const documents = state.data?.documents || [];
  const debug = state.data?.debug || null;

  const totals = useMemo(() => {
    if (state.data?.totals) return state.data.totals;
    return documents.reduce(
      (acc, doc) => {
        const v = Number(doc.value) || 0;
        acc.overall += v;
        if (STATUS_GROUPS.draft.has(doc.status)) acc.draft += v;
        if (STATUS_GROUPS.sentViewed.has(doc.status)) acc.sentViewed += v;
        if (STATUS_GROUPS.completedSigned.has(doc.status)) acc.completedSigned += v;
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
        <Text format={{ color: 'danger' }}>Error: {state.error}</Text>
      </Box>
    );
  }

  if (!documents.length) {
    return (
      <Flex direction="column" gap="small">
        <Text>No PandaDoc documents found.</Text>

        {debug && (
          <Box>
            <Divider />
            <Text format={{ fontWeight: 'bold' }}>Debug Info</Text>
            <Text>Deal ID sent: {debug.currentDealId || String(dealId) || '—'}</Text>
            <Text>Documents scanned: {debug.scannedDocumentCount ?? '—'}</Text>
            <Text>Detail fetches succeeded: {debug.detailSuccesses ?? '—'}</Text>
            <Text>Detail fetches failed: {debug.detailFailures ?? '—'}</Text>
            <Text>Timed out: {debug.timedOut ? 'Yes' : 'No'}</Text>
            <Text>Fields checked: {Array.isArray(debug.matchFieldsChecked) ? debug.matchFieldsChecked.join(', ') : '—'}</Text>

            {Array.isArray(debug.sampleDocuments) && debug.sampleDocuments.length > 0 && (
              <Box>
                <Divider />
                <Text format={{ fontWeight: 'bold' }}>Sample Documents from PandaDoc (first {debug.sampleDocuments.length})</Text>
                {debug.sampleDocuments.map((s, i) => (
                  <Box key={i}>
                    <Text format={{ fontWeight: 'bold' }}>{i + 1}. {s.name || '(no name)'}</Text>
                    <Text>Status: {s.status || '—'}</Text>
                    <Text>Created: {s.createdAt || '—'}</Text>
                    <Text>Metadata keys: {Array.isArray(s.metadataKeys) && s.metadataKeys.length > 0 ? s.metadataKeys.join(', ') : '(none)'}</Text>
                    <Text>metadata[hubspot.deal_id]: {s.metadataHubspotDealId || '(not set)'}</Text>
                    <Text>Token names (deal-related): {Array.isArray(s.tokenNamesSample) && s.tokenNamesSample.length > 0 ? s.tokenNamesSample.join(', ') : '(none found)'}</Text>
                    <Text>
                      Candidate IDs: {s.candidateDealIds && Object.keys(s.candidateDealIds).length > 0
                        ? Object.entries(s.candidateDealIds).map(([k, v]) => `${k}=${v}`).join(', ')
                        : '(none)'}
                    </Text>
                    <Divider />
                  </Box>
                ))}
              </Box>
            )}
          </Box>
        )}
      </Flex>
    );
  }

  return (
    <Flex direction="column" gap="small">
      <Box>
        <Text>Total # of Documents: {documents.length}</Text>
        <Text>Completed/signed total: {formatUsd(totals.completedSigned)}</Text>
        <Text>Draft total: {formatUsd(totals.draft)}</Text>
        <Text>Sent/viewed total: {formatUsd(totals.sentViewed)}</Text>
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
            <TableRow key={doc.id}>
              <TableCell>{doc.url ? <Link href={doc.url}>{doc.name}</Link> : doc.name}</TableCell>
              <TableCell>{doc.status || '—'}</TableCell>
              <TableCell>{formatUsd(doc.value)}</TableCell>
              <TableCell>{formatDate(doc.createdAt)}</TableCell>
              <TableCell>{doc.createdBy || '—'}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {documents[0]?.url && (
        <Button href={documents[0].url} size="small" variant="secondary">
          Open latest PandaDoc document
        </Button>
      )}
    </Flex>
  );
}
