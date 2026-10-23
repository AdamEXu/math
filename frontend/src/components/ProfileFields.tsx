import { CircleAlert, CircleCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { checkHandle } from "../api/me";
import type { Profile, ProfileErrors } from "../api/types";
import { useLatest } from "./overlay/focus";

const HANDLE_HINT = "3 to 20 characters: letters, numbers and underscores, starting with a letter.";
const CHECK_DELAY_MS = 250;

type HandleState = { state: "idle" | "ok" | "error"; text: string };

type ProfileFieldsProps = {
  profile: Profile;
  errors: ProfileErrors;
  currentHandle: string | null;
  onChange: (profile: Profile) => void;
  onSubmitAllowed: (allowed: boolean) => void;
};

export function normalizeHandle(handle: string) {
  return handle.trim().replace(/^@/, "").toLowerCase();
}

export function ProfileFields({ profile, errors, currentHandle, onChange, onSubmitAllowed }: ProfileFieldsProps) {
  const [handleState, setHandleState] = useState<HandleState>(
    errors.handle ? { state: "error", text: errors.handle } : { state: "idle", text: HANDLE_HINT },
  );
  const latest = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  const allow = useLatest(onSubmitAllowed);

  const check = async (raw: string) => {
    const value = normalizeHandle(raw);
    const id = ++latest.current;
    if (!value) {
      setHandleState({ state: "idle", text: HANDLE_HINT });
      allow.current(false);
      return;
    }
    if (value === currentHandle) {
      setHandleState({ state: "idle", text: "This is your current handle." });
      allow.current(true);
      return;
    }
    try {
      const data = await checkHandle(value);
      if (id !== latest.current) return;
      setHandleState(
        data.available
          ? { state: "ok", text: `@${data.handle} is available.` }
          : { state: "error", text: data.error ?? HANDLE_HINT },
      );
      allow.current(data.available);
    } catch {
      if (id !== latest.current) return;
      setHandleState({ state: "idle", text: HANDLE_HINT });
      allow.current(true);
    }
  };

  useEffect(() => {
    if (errors.handle) {
      latest.current++;
      setHandleState({ state: "error", text: errors.handle });
      allow.current(true);
    } else {
      void check(profile.handle);
    }
  }, [errors, currentHandle]);

  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <>
      <div className="field">
        <label className="label" htmlFor="display_name">
          Display name
        </label>
        <input
          className="text-input"
          id="display_name"
          name="display_name"
          type="text"
          value={profile.display_name}
          maxLength={50}
          autoComplete="name"
          required
          onChange={(event) => onChange({ ...profile, display_name: event.target.value })}
        />
        {errors.display_name ? (
          <p className="field-error">
            <CircleAlert />
            {errors.display_name}
          </p>
        ) : (
          <p className="hint">Shown to people you share graphs with.</p>
        )}
      </div>
      <div className="field">
        <label className="label" htmlFor="handle">
          Handle
        </label>
        <div className="handle-input">
          <span className="at">@</span>
          <input
            id="handle"
            name="handle"
            type="text"
            value={profile.handle}
            maxLength={21}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            required
            aria-describedby="handle-status"
            onChange={(event) => {
              const handle = event.target.value;
              onChange({ ...profile, handle });
              clearTimeout(timer.current);
              timer.current = window.setTimeout(() => void check(handle), CHECK_DELAY_MS);
            }}
          />
        </div>
        <p className="handle-status" id="handle-status" data-state={handleState.state} aria-live="polite">
          <CircleCheck className="when-ok" />
          <CircleAlert className="when-error" />
          <span>{handleState.text}</span>
        </p>
      </div>
    </>
  );
}
