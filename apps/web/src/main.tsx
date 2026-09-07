import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("missing #root element");

/**
 * `FeedbackProvider` is mounted by `App`, not here.
 *
 * It used to be in both places. Nesting two providers meant two independent toast queues
 * and two dialog slots, with the inner one winning, so anything the outer one was asked
 * to show silently never appeared.
 */
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
