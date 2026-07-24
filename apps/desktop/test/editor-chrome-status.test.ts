import { describe, expect, it } from 'vitest';

import {
  resolveAgentAccessStatus,
  resolveDocumentSaveStatus,
} from '../src/renderer/editor/editor-chrome-status.js';

describe('editor chrome status', () => {
  it('reserves recovery wording for an actual recovered session and requires Save As', () => {
    expect(
      resolveDocumentSaveStatus({
        dirty: true,
        durability: 'recovered',
        hasSaveTarget: false,
      }),
    ).toMatchObject({
      label: 'Recovered copy · Save As required',
      requiresSaveAs: true,
      tone: 'warning',
    });

    expect(
      resolveDocumentSaveStatus({
        dirty: true,
        durability: 'journaled',
        hasSaveTarget: true,
      }),
    ).toMatchObject({
      label: 'Unsaved changes · Recovery protected',
      requiresSaveAs: false,
    });

    expect(
      resolveDocumentSaveStatus({
        dirty: false,
        durability: 'clean',
        hasSaveTarget: false,
      }),
    ).toMatchObject({
      label: 'Not saved yet',
      requiresSaveAs: true,
    });
  });

  it('uses reader-facing labels for every runtime durability state', () => {
    const statuses = [
      resolveDocumentSaveStatus({
        dirty: false,
        durability: 'clean',
        hasSaveTarget: true,
      }),
      resolveDocumentSaveStatus({
        dirty: true,
        durability: 'journaled',
        hasSaveTarget: true,
      }),
      resolveDocumentSaveStatus({
        dirty: true,
        durability: 'saving',
        hasSaveTarget: true,
      }),
      resolveDocumentSaveStatus({
        dirty: true,
        durability: 'save-error',
        hasSaveTarget: true,
      }),
      resolveDocumentSaveStatus({
        dirty: true,
        durability: 'recovered',
        hasSaveTarget: false,
      }),
    ];

    expect(statuses.map((status) => status.label)).not.toContain('journaled');
    expect(statuses.map((status) => status.label)).toEqual([
      'Saved',
      'Unsaved changes · Recovery protected',
      'Saving…',
      'Save failed · Recovery preserved',
      'Recovered copy · Save As required',
    ]);
  });

  it('distinguishes an available MCP bridge from a connected agent', () => {
    expect(resolveAgentAccessStatus({ available: true, connected: false })).toMatchObject({
      label: 'Ready for an agent',
      tone: 'neutral',
    });
    expect(resolveAgentAccessStatus({ available: true, connected: true })).toMatchObject({
      label: 'Agent connected',
      tone: 'safe',
    });
    expect(resolveAgentAccessStatus({ available: false, connected: false })).toMatchObject({
      label: 'MCP unavailable',
      tone: 'danger',
    });
  });
});
