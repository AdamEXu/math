import { ChartSpline } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useDropdown } from "../components/menus";

export function NewGraphButton({ onCreate }: { onCreate: () => Promise<void> }) {
  const { open, toggleProps } = useDropdown();
  const [pending, setPending] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    try {
      await onCreate();
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="split-button dropdown">
      <form onSubmit={submit}>
        <button className="split-main" type="submit">
          <ChartSpline />
          New Graph
        </button>
      </form>
      <button className="split-caret" type="button" aria-label="More new graph options" {...toggleProps}>
        <span className="caret" />
      </button>
      <div className="menu" role="menu" hidden={!open}>
        <form onSubmit={submit}>
          <button className="menu-item" type="submit" role="menuitem">
            <ChartSpline />
            Blank Graph
          </button>
        </form>
      </div>
    </div>
  );
}
