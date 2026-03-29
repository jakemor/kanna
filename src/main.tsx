import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { BrowserRouter } from "react-router-dom"
import { App } from "./client/app/App"
import { ThemeProvider } from "./client/hooks/useTheme"
import { registerPwaServiceWorker } from "./client/pwa"
import "@xterm/xterm/css/xterm.css"
import "./index.css"

const container = document.getElementById("root")

if (!container) {
  throw new Error("Missing #root")
}

void registerPwaServiceWorker()

createRoot(container).render(
  <StrictMode>
    <BrowserRouter>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </BrowserRouter>
  </StrictMode>
)
