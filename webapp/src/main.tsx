import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { configureAmplify } from './amplifyConfig';
import { AuthProvider } from './auth/AuthContext';

configureAmplify();

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root container #root not found in index.html');
}

createRoot(container).render(
  <StrictMode>
    <AuthProvider>
      <App />
    </AuthProvider>
  </StrictMode>,
);
