import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import pngToIco from 'png-to-ico';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const inputSvgPath = path.join(projectRoot, 'public', 'jl-engine-logo.svg');
const buildDir = path.join(projectRoot, 'build');
const outputPngPath = path.join(buildDir, 'icon.png');
const outputIcoPath = path.join(buildDir, 'icon.ico');

const svgBuffer = await readFile(inputSvgPath);
const iconSizes = [16, 24, 32, 48, 64, 128, 256];
const pngBuffers = iconSizes.map((size) => {
  const renderer = new Resvg(svgBuffer, {
    fitTo: {
      mode: 'width',
      value: size,
    },
  });
  return renderer.render().asPng();
});

const largestPng = pngBuffers[pngBuffers.length - 1];
const icoBuffer = await pngToIco(pngBuffers);

await mkdir(buildDir, { recursive: true });
await writeFile(outputPngPath, largestPng);
await writeFile(outputIcoPath, icoBuffer);

console.log(`Generated icon assets:\n- ${outputPngPath}\n- ${outputIcoPath}`);
