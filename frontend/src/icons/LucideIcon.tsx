import { useIconMarkup } from "./registry";

export function LucideIcon({ name }: { name: string }) {
  const inner = useIconMarkup(name);
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`lucide lucide-${name}`}
      dangerouslySetInnerHTML={{ __html: inner }}
    />
  );
}

export function FolderIcon({ name, color }: { name: string; color?: string }) {
  return (
    <span className="folder-icon" data-icon={name} style={color ? { "--folder-color": color } : undefined}>
      <LucideIcon name={name} />
    </span>
  );
}
