import { useState } from "react";
import type { PublicUser } from "../api/types";

export type AvatarUser = Pick<PublicUser, "avatar_url" | "avatar_hue" | "avatar_initial">;

export function Avatar({ user, size }: { user: AvatarUser; size: number }) {
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
