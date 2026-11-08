import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/index.css";

function App() {
  return <div className="p-4 text-text">vallythevally</div>;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
