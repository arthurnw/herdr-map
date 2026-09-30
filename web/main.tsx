import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "next-themes";
import "@xyflow/react/dist/style.css";
import "./index.css";
import "./canvas.css";
import "./attention.css";
import "./usage.css";
import "./organize.css";
import "./links.css";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { App } from "./App.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem storageKey="herdr-map.theme" disableTransitionOnChange>
      <TooltipProvider delayDuration={300}>
        <App />
        <Toaster position="bottom-right" />
      </TooltipProvider>
    </ThemeProvider>
  </StrictMode>,
);
