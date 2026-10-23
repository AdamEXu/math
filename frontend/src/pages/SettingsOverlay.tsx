import { CircleAlert, CircleCheck } from "lucide-react";
import { useState } from "react";
import { useLocation, useNavigate } from "react-router";
import type { Me } from "../api/types";
import { Modal } from "../components/overlay/Modal";
import { ProfileFields, normalizeHandle } from "../components/ProfileFields";
import type { OverlayState } from "../components/UserMenu";
import { useProfileForm } from "../components/useProfileForm";
import { useDocumentTitle } from "../hooks/useDocumentTitle";

export function SettingsOverlay({ me }: { me: Me }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [saved, setSaved] = useState(false);
  const form = useProfileForm({ handle: me.handle ?? "", display_name: me.display_name }, () => setSaved(true));
  useDocumentTitle("Account settings - math");
  const changed =
    normalizeHandle(form.profile.handle) !== me.handle || form.profile.display_name.trim() !== me.display_name;
  const canSave = changed && form.submitAllowed && form.profile.display_name.trim() !== "";

  const close = () => {
    if ((location.state as OverlayState | null)?.backgroundLocation) navigate(-1);
    else navigate("/", { replace: true });
  };

  return (
    <Modal labelledBy="settings-heading" onDismiss={close}>
      <form
        className="panel"
        onSubmit={(event) => {
          setSaved(false);
          void form.submit(event);
        }}
      >
        <h1 id="settings-heading">Account settings</h1>
        <div className="field">
          <span className="label">Email</span>
          <div className="readonly">{me.email}</div>
          <p className="hint">Your Google account email. It can't be changed here.</p>
        </div>
        <ProfileFields
          profile={form.profile}
          errors={form.errors}
          currentHandle={me.handle}
          onChange={form.setProfile}
          onSubmitAllowed={form.setSubmitAllowed}
        />
        {form.failed && (
          <p className="field-error">
            <CircleAlert />
            Couldn't save your settings. Try again.
          </p>
        )}
        <div className="actions">
          {saved && (
            <span className="saved-note">
              <CircleCheck />
              Saved
            </span>
          )}
          <button className="btn-primary" type="submit" id="handle-submit" disabled={!canSave}>
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}
