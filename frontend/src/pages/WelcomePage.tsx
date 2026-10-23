import { CircleAlert } from "lucide-react";
import { Navigate, useSearchParams } from "react-router";
import type { Me } from "../api/types";
import { ProfileFields } from "../components/ProfileFields";
import { TopBar, TopBarTitle } from "../components/TopBar";
import { useProfileForm } from "../components/useProfileForm";
import { useBodyClass } from "../hooks/useBodyClass";
import { useDocumentTitle } from "../hooks/useDocumentTitle";

export function safeNext(target: string | null) {
  return target && target.startsWith("/") && !target.startsWith("//") ? target : null;
}

export function WelcomePage({ me }: { me: Me }) {
  const [params] = useSearchParams();
  if (me.handle) return <Navigate to={safeNext(params.get("next")) ?? "/"} replace />;
  return <Welcome me={me} />;
}

function Welcome({ me }: { me: Me }) {
  const form = useProfileForm({ handle: me.suggested_handle ?? "", display_name: me.display_name });
  useBodyClass("account-page");
  useDocumentTitle("Set up your profile - math");

  return (
    <>
      <TopBar title={<TopBarTitle>Welcome</TopBarTitle>} />
      <main className="account">
        <form className="panel" onSubmit={form.submit}>
          <h1>Set up your profile</h1>
          <p className="lede">
            Pick a handle and the name people will see. Your handle is how others find you when you share graphs. You
            can change both later in settings.
          </p>
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
              Couldn't save your profile. Try again.
            </p>
          )}
          <div className="actions">
            <button className="btn-primary" type="submit" id="handle-submit" disabled={!form.submitAllowed}>
              Continue
            </button>
          </div>
        </form>
      </main>
    </>
  );
}
