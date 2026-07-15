import type { ButtonHTMLAttributes, ReactNode } from 'react';

type EditorButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  label: string;
  children: ReactNode;
  text?: string;
  active?: boolean;
  shortcut?: string;
  compact?: boolean;
};

export function EditorButton({
  label,
  children,
  text,
  active,
  shortcut,
  compact = false,
  className = '',
  ...buttonProps
}: EditorButtonProps) {
  const title = shortcut ? `${label} (${shortcut})` : label;
  return (
    <button
      {...buttonProps}
      type="button"
      className={`editor-button ${compact ? 'is-compact' : ''} ${active ? 'is-active' : ''} ${className}`}
      aria-label={label}
      aria-pressed={active === undefined ? undefined : active}
      title={title}
    >
      {children}
      {text ? <span>{text}</span> : null}
    </button>
  );
}
