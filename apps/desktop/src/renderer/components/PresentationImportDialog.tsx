import type {
  ImportFidelityRecord,
  ImportFidelityStatus,
  PresentationImportPreview,
} from '@htmllelujah/pptx-importer';
import {
  CircleCheck,
  CircleX,
  FileText,
  LayoutTemplate,
  LoaderCircle,
  Palette,
  PanelsTopLeft,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react';
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from 'react';

import '../../styles/presentation-import-dialog.css';

const FIDELITY_STATUSES = [
  'imported',
  'substituted',
  'rasterized',
  'unsupported',
] as const satisfies readonly ImportFidelityStatus[];

const MAX_VISIBLE_RECORDS_PER_STATUS = 8;

const FIDELITY_COPY: Readonly<
  Record<ImportFidelityStatus, Readonly<{ label: string; description: string }>>
> = {
  imported: {
    label: 'Imported',
    description: 'Converted into native, editable design data.',
  },
  substituted: {
    label: 'Substituted',
    description: 'Imported with the documented fallback shown below.',
  },
  rasterized: {
    label: 'Rasterized',
    description: 'Preserved as pixels rather than editable vector content.',
  },
  unsupported: {
    label: 'Unsupported',
    description: 'Left out of this design-only import.',
  },
};

export type FidelityCounts = Readonly<Record<ImportFidelityStatus, number>>;

export const countImportFidelity = (fidelity: readonly ImportFidelityRecord[]): FidelityCounts => {
  const counts: Record<ImportFidelityStatus, number> = {
    imported: 0,
    substituted: 0,
    rasterized: 0,
    unsupported: 0,
  };
  for (const record of fidelity) counts[record.status] += 1;
  return counts;
};

export const fidelityRecordsByStatus = (
  fidelity: readonly ImportFidelityRecord[],
  status: ImportFidelityStatus,
  limit = MAX_VISIBLE_RECORDS_PER_STATUS,
): readonly ImportFidelityRecord[] =>
  fidelity.filter((record) => record.status === status).slice(0, Math.max(0, Math.trunc(limit)));

const formatPoints = (value: number): string =>
  Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/u, '');

const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
};

const safeErrorMessage = (error: unknown): string => {
  const message =
    error instanceof Error && error.message.trim() !== ''
      ? error.message.trim()
      : 'The design import could not be completed.';
  return message.slice(0, 1_000);
};

export interface PresentationImportDialogProps {
  readonly preview: PresentationImportPreview;
  readonly sourceName?: string | undefined;
  readonly busy?: boolean | undefined;
  readonly error?: string | null | undefined;
  readonly onCancel: () => void;
  readonly onImportDesign: (preview: PresentationImportPreview) => void | Promise<void>;
}

export function PresentationImportDialog({
  preview,
  sourceName = 'Presentation file',
  busy = false,
  error,
  onCancel,
  onImportDesign,
}: PresentationImportDialogProps): ReactElement {
  const headingId = useId();
  const descriptionId = useId();
  const errorId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const pending = busy || submitting;
  const visibleError = error?.trim() || localError;
  const fidelityCounts = countImportFidelity(preview.fidelity);

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  useEffect(() => {
    setLocalError(null);
  }, [preview]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || pending) return;
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [onCancel, pending]);

  const trapDialogFocus = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Tab') return;
    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    );
    const first = focusable[0];
    const last = focusable.at(-1);
    if (first === undefined || last === undefined) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const importDesign = async (): Promise<void> => {
    if (pending) return;
    setLocalError(null);
    setSubmitting(true);
    try {
      await onImportDesign(preview);
    } catch (importError) {
      setLocalError(safeErrorMessage(importError));
    } finally {
      setSubmitting(false);
    }
  };

  const describedBy = visibleError ? `${descriptionId} ${errorId}` : descriptionId;

  return (
    <div
      className="modal-backdrop presentation-import-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !pending) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        className="presentation-import-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        aria-describedby={describedBy}
        aria-busy={pending}
        onKeyDown={trapDialogFocus}
      >
        <header className="presentation-import-header">
          <div className="presentation-import-heading-mark" aria-hidden="true">
            <LayoutTemplate size={20} />
          </div>
          <div>
            <p className="presentation-import-eyebrow">Presentation design preview</p>
            <h2 id={headingId}>Import design from {sourceName}</h2>
            <p id={descriptionId}>
              Review what can be converted before making any change to this presentation.
            </p>
          </div>
        </header>

        <div className="presentation-import-scope" role="note">
          <ShieldCheck aria-hidden="true" size={18} />
          <div>
            <strong>Design-only, preview first</strong>
            <p>
              This imports page size, themes, masters, and layouts. Slide content is not imported.
              The source file is read-only for this operation and remains unchanged.
            </p>
          </div>
        </div>

        <div className="presentation-import-body">
          <section className="presentation-import-section" aria-labelledby={`${headingId}-summary`}>
            <div className="presentation-import-section-heading">
              <div>
                <h3 id={`${headingId}-summary`}>Design summary</h3>
                <p>
                  {formatBytes(preview.source.archiveBytes)} source ·{' '}
                  {preview.source.slidePartCount} slide
                  {preview.source.slidePartCount === 1 ? '' : 's'} left unchanged
                </p>
              </div>
              <FileText aria-hidden="true" size={17} />
            </div>
            <dl className="presentation-import-summary-grid">
              <div>
                <dt>Page size</dt>
                <dd>
                  {formatPoints(preview.pageSize.widthPt)} ×{' '}
                  {formatPoints(preview.pageSize.heightPt)} pt
                </dd>
              </div>
              <div>
                <dt>Themes</dt>
                <dd>{preview.themes.length}</dd>
              </div>
              <div>
                <dt>Masters</dt>
                <dd>{preview.masters.length}</dd>
              </div>
              <div>
                <dt>Layouts</dt>
                <dd>{preview.layouts.length}</dd>
              </div>
            </dl>
          </section>

          <section
            className="presentation-import-section"
            aria-labelledby={`${headingId}-fidelity`}
          >
            <div className="presentation-import-section-heading">
              <div>
                <h3 id={`${headingId}-fidelity`}>Fidelity report</h3>
                <p>Every analyzed design item is classified before import.</p>
              </div>
              <Palette aria-hidden="true" size={17} />
            </div>

            <div
              className="presentation-import-fidelity-summary"
              aria-label="Fidelity status counts"
            >
              {FIDELITY_STATUSES.map((status) => (
                <article
                  key={status}
                  className={`presentation-import-fidelity-card status-${status}`}
                >
                  <span>{FIDELITY_COPY[status].label}</span>
                  <strong>{fidelityCounts[status]}</strong>
                  <small>{FIDELITY_COPY[status].description}</small>
                </article>
              ))}
            </div>

            <div className="presentation-import-fidelity-details">
              {FIDELITY_STATUSES.map((status) => {
                const records = fidelityRecordsByStatus(preview.fidelity, status);
                if (records.length === 0) return null;
                const hiddenCount = fidelityCounts[status] - records.length;
                return (
                  <section
                    key={status}
                    className={`presentation-import-fidelity-group status-${status}`}
                    aria-labelledby={`${headingId}-fidelity-${status}`}
                  >
                    <h4 id={`${headingId}-fidelity-${status}`}>
                      {status === 'imported' ? (
                        <CircleCheck aria-hidden="true" size={14} />
                      ) : status === 'unsupported' ? (
                        <CircleX aria-hidden="true" size={14} />
                      ) : (
                        <TriangleAlert aria-hidden="true" size={14} />
                      )}
                      {FIDELITY_COPY[status].label}
                    </h4>
                    <ul>
                      {records.map((record) => (
                        <li key={record.id}>
                          <div>
                            <strong>{record.itemKind}</strong>
                            <code>{record.sourcePart}</code>
                          </div>
                          <p>{record.detail}</p>
                        </li>
                      ))}
                    </ul>
                    {hiddenCount > 0 ? (
                      <p className="presentation-import-more">
                        {hiddenCount} additional {FIDELITY_COPY[status].label.toLowerCase()} item
                        {hiddenCount === 1 ? '' : 's'} included in the report.
                      </p>
                    ) : null}
                  </section>
                );
              })}
            </div>
          </section>

          {preview.warnings.length > 0 ? (
            <section
              className="presentation-import-section presentation-import-warnings"
              aria-labelledby={`${headingId}-warnings`}
            >
              <div className="presentation-import-section-heading">
                <div>
                  <h3 id={`${headingId}-warnings`}>Warnings</h3>
                  <p>Review these limitations before importing the design.</p>
                </div>
                <TriangleAlert aria-hidden="true" size={17} />
              </div>
              <ul>
                {preview.warnings.map((warning, index) => (
                  <li key={`${warning.code}-${warning.sourcePart ?? 'global'}-${index}`}>
                    <div>
                      <strong>{warning.code}</strong>
                      {warning.sourcePart === undefined ? null : <code>{warning.sourcePart}</code>}
                    </div>
                    <p>{warning.message}</p>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>

        {visibleError ? (
          <div id={errorId} className="presentation-import-error" role="alert">
            <CircleX aria-hidden="true" size={16} />
            <span>{visibleError}</span>
          </div>
        ) : null}

        <footer className="presentation-import-footer">
          <p>
            <PanelsTopLeft aria-hidden="true" size={15} />
            Existing slide content and the source file remain unchanged.
          </p>
          <div>
            <button
              ref={cancelRef}
              type="button"
              className="presentation-import-cancel"
              disabled={pending}
              onClick={onCancel}
            >
              Cancel
            </button>
            <button
              type="button"
              className="presentation-import-confirm"
              disabled={pending}
              aria-describedby={descriptionId}
              onClick={() => void importDesign()}
            >
              {pending ? (
                <>
                  <LoaderCircle
                    className="presentation-import-spinner"
                    aria-hidden="true"
                    size={15}
                  />
                  Importing design…
                </>
              ) : (
                'Import design only'
              )}
            </button>
          </div>
          {pending ? (
            <span className="sr-only" role="status" aria-live="polite">
              Importing design. Please wait.
            </span>
          ) : null}
        </footer>
      </div>
    </div>
  );
}
