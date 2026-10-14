import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { Popup } from './popup'
import '@/styles/globals.css'

const el = document.getElementById('root')
if (!el) throw new Error('WebPilot: popup root element is missing.')

createRoot(el).render(
  <React.StrictMode>
    <Popup />
  </React.StrictMode>,
)