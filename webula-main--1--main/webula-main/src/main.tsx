import { createRoot } from 'react-dom/client';
import { Analytics } from '@vercel/analytics/react';
import NeuralExplorer3D from '../.github/instructions/NeuralExplorer3D';

const rootElement = document.getElementById('root');

if (rootElement) {
  createRoot(rootElement).render(
    <>
      <NeuralExplorer3D />
      <Analytics />
    </>,
  );
}
