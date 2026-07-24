import type { SessionDurability } from '@htmllelujah/document-runtime';

export type ChromeStatusTone = 'neutral' | 'safe' | 'warning' | 'danger' | 'progress';

export interface DocumentSaveStatus {
  readonly label: string;
  readonly detail: string;
  readonly tone: ChromeStatusTone;
  readonly requiresSaveAs: boolean;
}

export interface DocumentSaveStatusInput {
  readonly dirty: boolean;
  readonly durability: SessionDurability;
  readonly hasSaveTarget: boolean;
}

/**
 * Converts runtime durability into reader-facing language. Runtime enum values are deliberately
 * kept out of the UI because "journaled" is an implementation detail, not a save outcome.
 */
export const resolveDocumentSaveStatus = (input: DocumentSaveStatusInput): DocumentSaveStatus => {
  if (input.durability === 'recovered') {
    return {
      label: 'Recovered copy · Save As required',
      detail: 'This recovered copy has no file target. Use Save As to keep it.',
      tone: 'warning',
      requiresSaveAs: true,
    };
  }

  if (input.durability === 'saving') {
    return {
      label: 'Saving…',
      detail: 'Writing the presentation to its local file.',
      tone: 'progress',
      requiresSaveAs: !input.hasSaveTarget,
    };
  }

  if (input.durability === 'save-error') {
    return {
      label: 'Save failed · Recovery preserved',
      detail: 'The presentation could not be saved. Your accepted edits remain backed up locally.',
      tone: 'danger',
      requiresSaveAs: !input.hasSaveTarget,
    };
  }

  if (input.dirty) {
    return {
      label: input.hasSaveTarget
        ? 'Unsaved changes · Recovery protected'
        : 'Not saved yet · Recovery protected',
      detail: 'Unsaved edits are backed up locally until you save the presentation.',
      tone: 'warning',
      requiresSaveAs: !input.hasSaveTarget,
    };
  }

  if (!input.hasSaveTarget) {
    return {
      label: 'Not saved yet',
      detail: 'Choose a location the first time you save this presentation.',
      tone: 'neutral',
      requiresSaveAs: true,
    };
  }

  return {
    label: 'Saved',
    detail: 'All accepted edits are saved to the local presentation file.',
    tone: 'safe',
    requiresSaveAs: false,
  };
};

export interface AgentAccessStatus {
  readonly label: string;
  readonly detail: string;
  readonly tone: ChromeStatusTone;
}

export interface AgentAccessStatusInput {
  readonly available: boolean;
  readonly connected: boolean;
}

export const resolveAgentAccessStatus = (
  input: AgentAccessStatusInput | null,
): AgentAccessStatus => {
  if (input === null) {
    return {
      label: 'Checking MCP…',
      detail: 'Checking the local agent bridge.',
      tone: 'neutral',
    };
  }
  if (input.connected) {
    return {
      label: 'Agent connected',
      detail: 'An authenticated local MCP client is connected.',
      tone: 'safe',
    };
  }
  if (input.available) {
    return {
      label: 'Ready for an agent',
      detail: 'The local MCP bridge is running, but no client is connected.',
      tone: 'neutral',
    };
  }
  return {
    label: 'MCP unavailable',
    detail: 'The local MCP bridge is not running.',
    tone: 'danger',
  };
};
