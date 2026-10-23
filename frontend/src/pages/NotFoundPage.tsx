import { FileQuestion } from "lucide-react";
import { EmptyState } from "../components/EmptyState";
import { TopBar, TopBarTitle } from "../components/TopBar";
import { useDocumentTitle } from "../hooks/useDocumentTitle";

export function NotFoundPage() {
  useDocumentTitle("Not found - math");
  return (
    <>
      <TopBar title={<TopBarTitle>Not found</TopBarTitle>} />
      <EmptyState icon={<FileQuestion />} title="Page not found">
        This page doesn't exist, or you don't have access to it.
      </EmptyState>
    </>
  );
}
