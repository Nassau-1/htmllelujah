import {
  applyTransaction,
  createRevisionToken,
  type DeckDocument,
  type DocumentCommand,
} from '@htmllelujah/document-core';

import { MCP_LIMITS, type DesignOperation } from './contracts.js';
import { McpSafeError } from './service.js';

const metadata = Object.freeze({
  transactionId: '00000000-0000-4000-8000-000000000001',
  actorId: 'mcp-design-operation-planner',
  origin: 'agent' as const,
  label: 'Plan typed design operations',
  timestamp: '2000-01-01T00:00:00.000Z',
});

const enforceThemeCommands = (
  document: DeckDocument,
  themeId: string,
): readonly DocumentCommand[] => {
  if (!document.themes.some((theme) => theme.id === themeId)) {
    throw new McpSafeError('NOT_FOUND', 'The requested theme does not exist.');
  }
  return [{ type: 'theme.enforce-deck', themeId }];
};

const operationCommands = (
  document: DeckDocument,
  operation: DesignOperation,
): readonly DocumentCommand[] => {
  switch (operation.type) {
    case 'page.set':
      return [{ type: 'deck.set-page', page: operation.page }];
    case 'theme.create':
      return [
        {
          type: 'theme.create',
          theme: operation.theme,
          ...(operation.index === undefined ? {} : { index: operation.index }),
        },
      ];
    case 'theme.update': {
      const theme = document.themes.find((candidate) => candidate.id === operation.themeId);
      if (theme === undefined) throw new McpSafeError('NOT_FOUND', 'The theme does not exist.');
      return [
        {
          type: 'theme.update',
          themeId: theme.id,
          replacement: {
            ...theme,
            ...(operation.patch.name === undefined ? {} : { name: operation.patch.name }),
            ...(operation.patch.headingFontFamily === undefined
              ? {}
              : { headingFontFamily: operation.patch.headingFontFamily }),
            ...(operation.patch.bodyFontFamily === undefined
              ? {}
              : { bodyFontFamily: operation.patch.bodyFontFamily }),
            ...(operation.patch.textStyles === undefined
              ? {}
              : { textStyles: operation.patch.textStyles }),
            colors:
              operation.patch.colors === undefined
                ? theme.colors
                : {
                    background: operation.patch.colors.background ?? theme.colors.background,
                    surface: operation.patch.colors.surface ?? theme.colors.surface,
                    text: operation.patch.colors.text ?? theme.colors.text,
                    mutedText: operation.patch.colors.mutedText ?? theme.colors.mutedText,
                    accent: operation.patch.colors.accent ?? theme.colors.accent,
                  },
          },
        },
      ];
    }
    case 'theme.delete':
      return [
        {
          type: 'theme.delete',
          themeId: operation.themeId,
          ...(operation.replacementThemeId === undefined
            ? {}
            : { replacementThemeId: operation.replacementThemeId }),
        },
      ];
    case 'theme.enforce-deck':
      return enforceThemeCommands(document, operation.themeId);
    case 'master.create':
      return [
        {
          type: 'master.create',
          master: operation.master,
          ...(operation.index === undefined ? {} : { index: operation.index }),
        },
      ];
    case 'master.update': {
      const master = document.masters.find((candidate) => candidate.id === operation.masterId);
      if (master === undefined) throw new McpSafeError('NOT_FOUND', 'The master does not exist.');
      const { background, elements, guides, name, themeId } = operation.patch;
      return [
        {
          type: 'master.update',
          masterId: master.id,
          replacement: {
            ...master,
            ...(name === undefined ? {} : { name }),
            ...(themeId === undefined ? {} : { themeId }),
            ...(elements === undefined ? {} : { elements }),
            ...(guides === undefined ? {} : { guides }),
            ...(background === undefined
              ? {}
              : background === null
                ? { background: undefined }
                : { background }),
          },
        },
      ];
    }
    case 'master.delete':
      return [
        {
          type: 'master.delete',
          masterId: operation.masterId,
          ...(operation.replacementMasterId === undefined
            ? {}
            : { replacementMasterId: operation.replacementMasterId }),
        },
      ];
    case 'layout.create':
      return [
        {
          type: 'layout.create',
          layout: operation.layout,
          ...(operation.index === undefined ? {} : { index: operation.index }),
        },
      ];
    case 'layout.update': {
      const layout = document.layouts.find((candidate) => candidate.id === operation.layoutId);
      if (layout === undefined) throw new McpSafeError('NOT_FOUND', 'The layout does not exist.');
      const { background, elements, guides, masterId, name } = operation.patch;
      return [
        {
          type: 'layout.update',
          layoutId: layout.id,
          replacement: {
            ...layout,
            ...(name === undefined ? {} : { name }),
            ...(masterId === undefined ? {} : { masterId }),
            ...(elements === undefined ? {} : { elements }),
            ...(guides === undefined ? {} : { guides }),
            ...(background === undefined
              ? {}
              : background === null
                ? { background: undefined }
                : { background }),
          },
        },
      ];
    }
    case 'layout.delete':
      return [
        {
          type: 'layout.delete',
          layoutId: operation.layoutId,
          ...(operation.replacementLayoutId === undefined
            ? {}
            : { replacementLayoutId: operation.replacementLayoutId }),
        },
      ];
    case 'slide.set-layout':
      return [
        {
          type: 'slide.set-layout',
          slideId: operation.slideId,
          layoutId: operation.layoutId,
        },
      ];
  }
};

/**
 * Resolves semantic design operations into the existing canonical command language.
 *
 * Each intermediate state is run through the document command engine, so references,
 * limits, placeholder rules, and sequential batch semantics are identical to commit.
 */
export const designOperationsToCommands = (
  document: DeckDocument,
  operations: readonly DesignOperation[],
): readonly DocumentCommand[] => {
  let working = document;
  const commands: DocumentCommand[] = [];
  for (const operation of operations) {
    const next = operationCommands(working, operation);
    if (commands.length + next.length > MCP_LIMITS.maxCommands) {
      throw new McpSafeError(
        'INVALID_REQUEST',
        'The design operation expands beyond the bounded command limit.',
      );
    }
    if (next.length === 0) continue;
    working = applyTransaction(working, next, {
      expectedRevision: createRevisionToken(working),
      metadata,
    }).document;
    commands.push(...next);
  }
  if (commands.length === 0) {
    throw new McpSafeError('INVALID_REQUEST', 'The design operations have no effect.');
  }
  return commands;
};
