import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import AlphaAgentPage from './pages/AlphaAgentPage.tsx'

const isAlpha = window.location.pathname.startsWith('/alpha-agent')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isAlpha ? <AlphaAgentPage /> : <App />}
  </StrictMode>,
)
