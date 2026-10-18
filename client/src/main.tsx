import { createRoot } from 'react-dom/client';
import '@ibm/plex-sans-arabic/css/ibm-plex-sans-arabic-default.css';
import { App } from './App';
import './styles.css';

const root = document.getElementById('root');

if (!root) {
  throw new Error('Application root element was not found.');
}

createRoot(root).render(<App />);
