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
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return '—';
  }
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  }).format(Number(value));
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
  const [state, setState] = useState({ loading: true, error: null, data: null });

  useEffect(() => {
    let isMounted = true;

    const load = async () => {
      if (!dealId) {
        if (isMounted) {
          setState({ loading: false, error: 'No HubSpot Deal ID found in context.', data: null });
        }
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
    return () => {
      isMounted = false;
    };
  }, [dealId, runServerlessFunction]);

  const documents = state.data?.documents || [];

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
    return <Text>No PandaDoc documents found.</Text>;
  }

  return (
    <Flex direction="column" gap="small">
      <Box>
        <Text><strong>Draft total:</strong> {formatUsd(totals.draft)}</Text>
        <Text><strong>Sent/viewed total:</strong> {formatUsd(totals.sentViewed)}</Text>
        <Text><strong>Completed/signed total:</strong> {formatUsd(totals.completedSigned)}</Text>
        <Text><strong>Overall total:</strong> {formatUsd(totals.overall)}</Text>
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
              <TableCell>
                {doc.url ? <Link href={doc.url}>{doc.name}</Link> : doc.name}
              </TableCell>
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
