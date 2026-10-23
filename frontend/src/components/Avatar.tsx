import { useState } from "react";
import type { Me } from "../api/types";

export function Avatar({ user, size }: { user: Me; size: number }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const url = user.avatar_url !== failedUrl ? user.avatar_url : null;
  return (
    <span
      className="avatar"
      style={{ "--avatar-size": `${size}px`, "--avatar-hue": user.avatar_hue }}
      aria-hidden="true"
    >
      {user.avatar_initial}
      {url && <img src={url} alt="" referrerPolicy="no-referrer" onError={() => setFailedUrl(url)} />}
    </span>
  );
}
