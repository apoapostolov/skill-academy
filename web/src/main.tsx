import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import DevPanel from './DevPanel'
import './styles.css'

const isDev = window.location.pathname.startsWith('/dev')

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>{isDev ? <DevPanel /> : <App />}</React.StrictMode>
)
