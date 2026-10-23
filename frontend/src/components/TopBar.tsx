import { House } from "lucide-react";
import type { MouseEvent, ReactNode } from "react";
import { Link } from "react-router";
import { useMe } from "../api/queries";
import { UserMenu } from "./UserMenu";

type TopBarProps = {
  title: ReactNode;
  status?: ReactNode;
  onHome?: (event: MouseEvent<HTMLAnchorElement>) => void;
};

export function TopBar({ title, status, onHome }: TopBarProps) {
  const { data: user } = useMe();
  return (
    <header className="topbar">
      <div className="topbar-left">
        <Link className="tb-icon" to="/" id="open-library" title="Home" aria-label="Home" onClick={onHome}>
          <House />
        </Link>
        <div className="tb-title-block">{title}</div>
        {status}
      </div>
      <Link className="wordmark" to="/">
        math
      </Link>
      <div className="topbar-right">{user && <UserMenu user={user} />}</div>
    </header>
  );
}

export function TopBarTitle({ children }: { children: ReactNode }) {
  return <span className="tb-title">{children}</span>;
}
