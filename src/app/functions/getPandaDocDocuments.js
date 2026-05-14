exports.main = async (context = {}) => {
  const dealId = context?.parameters?.dealId || null;
  const timestamp = new Date().toISOString();

  return {
    statusCode: 200,
    body: {
      documents: [
        {
          id: 'diagnostic-test',
          name: 'Diagnostic PandaDoc Test',
          status: 'document.draft',
          value: 12345.67,
          currency: 'USD',
          createdAt: timestamp,
          createdBy: 'diagnostic',
          url: null,
        },
      ],
      totals: {
        draft: 12345.67,
        sentViewed: 0,
        completedSigned: 0,
        overall: 12345.67,
      },
      debug: {
        diagnosticMode: true,
        receivedDealId: dealId,
        timestamp,
      },
    },
  };
};
