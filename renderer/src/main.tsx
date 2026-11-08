import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// Note: intentionally NOT wrapped in <StrictMode>. StrictMode double-invokes
// effects in development (mount -> cleanup -> mount again), which would make
// TerminalView open a remote shell and immediately replace it with a second
// one (ssh.ts closes the superseded shell, so it is wasteful rather than
// broken). This app has no concurrent-rendering workloads that benefit from
// StrictMode, so it is skipped entirely.
createRoot(document.getElementById('root')!).render(<App />)
