import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { foldersQuery, graphsQuery, meQuery, queryClient } from "./api/queries";
import { App } from "./App";
import { ToastProvider } from "./components/Toast";
import "./styles/app.css";
import "./styles/base.css";
import "./styles/library.css";
import "./styles/calculator.css";
import "./styles/account.css";
import "./styles/overlay.css";

void queryClient.prefetchQuery(meQuery);
void queryClient.prefetchQuery(graphsQuery);
void queryClient.prefetchQuery(foldersQuery);

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ToastProvider>
          <App />
        </ToastProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
