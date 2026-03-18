import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { BrowserRouter } from "react-router-dom"
import { init as initGhostty } from "ghostty-web"
import { App } from "./client/app/App"
import { ThemeProvider } from "./client/hooks/useTheme"
import "./index.css"

const container = document.getElementById("root")

if (!container) {
  throw new Error("Missing #root")
}

const rootContainer = container

async function bootstrap() {
  await initGhostty()

  createRoot(rootContainer).render(
    <StrictMode>
      <BrowserRouter>
        <ThemeProvider>
          <App />
        </ThemeProvider>
      </BrowserRouter>
    </StrictMode>
  )
}

void bootstrap()
