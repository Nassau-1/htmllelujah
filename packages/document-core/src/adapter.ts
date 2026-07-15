import type { DocumentCommand, TransactionOptions } from './commands.js';
import {
  applyTransaction,
  type DocumentSnapshot,
  type TransactionResult,
} from './command-engine.js';
import type { DeckDocument } from './model.js';
import { createRevisionToken } from './revision.js';
import { parseDeck } from './validation.js';

export type DocumentChangeListener = (snapshot: DocumentSnapshot) => void;

/** Persistence-neutral boundary intended for memory, Yjs, or remote adapters. */
export interface DocumentAdapter {
  getSnapshot(): DocumentSnapshot;
  transact(commands: readonly DocumentCommand[], options: TransactionOptions): TransactionResult;
  subscribe(listener: DocumentChangeListener): () => void;
}

export class InMemoryDocumentAdapter implements DocumentAdapter {
  private document: DeckDocument;
  private readonly listeners = new Set<DocumentChangeListener>();

  public constructor(initialDocument: DeckDocument) {
    this.document = parseDeck(initialDocument);
  }

  public getSnapshot(): DocumentSnapshot {
    return {
      document: structuredClone(this.document),
      revision: createRevisionToken(this.document),
    };
  }

  public transact(
    commands: readonly DocumentCommand[],
    options: TransactionOptions,
  ): TransactionResult {
    const result = applyTransaction(this.document, commands, options);
    this.document = result.document;
    const snapshot = this.getSnapshot();
    this.listeners.forEach((listener) => listener(snapshot));
    return result;
  }

  public subscribe(listener: DocumentChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
