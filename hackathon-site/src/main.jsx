import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import Lenis from 'lenis'
import 'lenis/dist/lenis.css'
import './index.css'
import App from './App.jsx'

const lenis = new Lenis({
  autoRaf: true,
  smoothWheel: true,
  lerp: 0.08,
})

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    lenis.destroy()
  })
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
