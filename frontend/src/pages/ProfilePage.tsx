import { UserRound } from "lucide-react";
import { useParams } from "react-router";
import { EmptyState } from "../components/EmptyState";
import { TopBar, TopBarTitle } from "../components/TopBar";
import { useDocumentTitle } from "../hooks/useDocumentTitle";

export function ProfilePage() {
  const { handle = "" } = useParams();
  useDocumentTitle(`@${handle} - math`);
  return (
    <>
      <TopBar title={<TopBarTitle>Profile</TopBarTitle>} />
      <EmptyState icon={<UserRound />} title={`@${handle}`}>
        Profiles are coming soon.
      </EmptyState>
    </>
  );
}
