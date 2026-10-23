import type { ReactNode } from "react";

type EmptyStateProps = { id?: string; icon: ReactNode; title: string; children: ReactNode };

export function EmptyState({ id, icon, title, children }: EmptyStateProps) {
  return (
    <div className="empty" id={id}>
      <span className="empty-icon">{icon}</span>
      <div className="empty-title">{title}</div>
      <p className="empty-text">{children}</p>
    </div>
  );
}
