import type { ReactNode } from 'react';
/** Shared layout: context on the left, actions on the right. */
export function WorkspaceToolbar({
  context,
  children,
  className = '',
}: {
  context?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`workspace-toolbar ${className}`}>
      <div className="workspace-toolbar-context">{context}</div>
      <div className="workspace-toolbar-actions">{children}</div>
    </div>
  );
}
