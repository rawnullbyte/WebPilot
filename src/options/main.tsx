import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { Options } from './options'
import '@/styles/globals.css'

const el = document.getElementById('root')
if (!el) throw new Error('WebPilot: options root element is missing.')

createRoot(el).render(
  <React.StrictMode>
    <Options />
  </React.StrictMode>,
)