import type { PublicUser } from "../api/types";
import { Avatar } from "../components/Avatar";
import { useHoverTip } from "../components/HoverTip";
import { presenceColor } from "./colors";

const MAX_SHOWN = 4;
const SIZES = { header: { size: 32, ring: 3 }, card: { size: 22, ring: 2 }, row: { size: 36, ring: 3 } };

export type PresenceSize = keyof typeof SIZES;

export function PresenceAvatar({ user, size }: { user: PublicUser; size: PresenceSize }) {
  const { size: outer, ring } = SIZES[size];
  return (
    <span className="presence-avatar" style={{ "--presence": presenceColor(user.id), "--presence-size": `${outer}px` }}>
      <Avatar user={user} size={outer - ring * 2} />
    </span>
  );
}

type StackProps = { users: PublicUser[]; size: PresenceSize; onOpen?: () => void; label?: string };

export function PresenceStack({ users, size, onOpen, label }: StackProps) {
  const { tipProps, tip } = useHoverTip();
  if (!users.length) return null;
  const shown = users.slice(0, MAX_SHOWN);
  const hidden = users.slice(MAX_SHOWN);
  const names = users.map((user) => user.display_name).join(", ");
  const content = (
    <>
      {shown.map((user) => (
        <span key={user.id} className="presence-item" {...tipProps(user.display_name)}>
          <PresenceAvatar user={user} size={size} />
        </span>
      ))}
      {hidden.length > 0 && (
        <span className="presence-more" {...tipProps(hidden.map((user) => user.display_name).join(", "))}>
          +{hidden.length}
        </span>
      )}
      {tip}
    </>
  );
  const className = `presence-stack presence-${size}`;
  if (!onOpen) {
    return (
      <span className={className} role="group" aria-label={`Here now: ${names}`}>
        {content}
      </span>
    );
  }
  return (
    <button className={className} type="button" aria-label={label ?? `Here now: ${names}`} onClick={onOpen}>
      {content}
    </button>
  );
}
