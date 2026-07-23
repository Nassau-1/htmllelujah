export const pendingPublicDistributionCompliance = () => ({
  schemaVersion: 1,
  passed: false,
  correspondingSource: {
    status: 'pending',
    evidence: null,
  },
  thirdPartyNotices: {
    status: 'incomplete',
    evidence: null,
  },
  qualifiedApproval: {
    status: 'pending',
    evidence: null,
  },
});
