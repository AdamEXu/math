import { useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { ApiError } from "../api/client";
import { saveProfile } from "../api/me";
import { keys } from "../api/queries";
import type { Me, Profile, ProfileErrors, ProfileRejection } from "../api/types";

const NO_ERRORS: ProfileErrors = {};

function isRejection(data: unknown): data is ProfileRejection {
  return typeof data === "object" && data !== null && "errors" in data && "profile" in data;
}

export function useProfileForm(initial: Profile, onSaved?: (me: Me) => void) {
  const client = useQueryClient();
  const [profile, setProfile] = useState(initial);
  const [errors, setErrors] = useState<ProfileErrors>(NO_ERRORS);
  const [failed, setFailed] = useState(false);
  const [submitAllowed, setSubmitAllowed] = useState(true);
  const [pending, setPending] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setFailed(false);
    try {
      const me = await saveProfile(profile);
      setErrors(NO_ERRORS);
      setProfile({ handle: me.handle ?? "", display_name: me.display_name });
      client.setQueryData(keys.me, me);
      onSaved?.(me);
    } catch (error) {
      if (error instanceof ApiError && error.status === 400 && isRejection(error.data)) {
        setErrors(error.data.errors);
        setProfile(error.data.profile);
      } else {
        console.error(error);
        setFailed(true);
      }
    } finally {
      setPending(false);
    }
  };

  return { profile, setProfile, errors, failed, submitAllowed, setSubmitAllowed, submit };
}
