import { LogOut, Settings } from "lucide-react";
import { useRef } from "react";
import { Link, type Location, useLocation } from "react-router";
import type { Me } from "../api/types";
import { Avatar } from "./Avatar";
import { useDropdown } from "./menus";
import { setFocusReturn } from "./overlay/focus";

export type OverlayState = { backgroundLocation?: Location };

export function UserMenu({ user }: { user: Me }) {
  const { open, toggleProps } = useDropdown();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const location = useLocation();
  const background = (location.state as OverlayState | null)?.backgroundLocation ?? location;

  const identity = (
    <>
      <Avatar user={user} size={36} />
      <div className="menu-user-text">
        <div className="menu-name">{user.display_name}</div>
        {user.handle && <div className="menu-handle">{`@${user.handle}`}</div>}
      </div>
    </>
  );

  return (
    <div className="dropdown user-menu">
      <button className="user-button" type="button" ref={buttonRef} {...toggleProps}>
        <Avatar user={user} size={28} />
        <span className="user-name">{user.display_name}</span>
        <span className="caret" />
      </button>
      <div className="menu menu-right" role="menu" hidden={!open}>
        {user.handle ? (
          <Link className="menu-user" role="menuitem" to={`/profile/${user.handle}`}>
            {identity}
          </Link>
        ) : (
          <div className="menu-user">{identity}</div>
        )}
        {user.handle && (
          <Link
            className="menu-item"
            role="menuitem"
            to="/settings"
            state={{ backgroundLocation: background } satisfies OverlayState}
            onClick={() => setFocusReturn(buttonRef.current)}
          >
            <Settings />
            Account settings
          </Link>
        )}
        <form method="post" action="/auth/logout">
          <button className="menu-item" type="submit" role="menuitem">
            <LogOut />
            Sign out
          </button>
        </form>
      </div>
    </div>
  );
}
