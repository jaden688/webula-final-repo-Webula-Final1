# Neural Explorer 3D – Webula

**Neural Nexus**  
Interactive 3D visualization of your codebase as a glowing, force-directed neural graph.

Explore file dependencies, imports, folder structures, and project connections in a beautiful, tunable 3D space — with starfield backgrounds, glow effects, physics simulation controls, and more.

Live demo: [https://webula-final-repo.vercel.app](https://webula-final-repo.vercel.app)

![Neural Explorer 3D Screenshot](https://via.placeholder.com/1200x600?text=Add+a+screenshot+or+gif+here)  
*(Tip: Record a short GIF of mounting a folder + tuning params and upload it to the repo for this spot!)*

## Features

- **Mount & Parse Folders** — Use your browser to select a local project folder and analyze its structure (up to 400 files / 512 KB per file).
- **3D Force-Directed Graph** — Nodes represent files/folders, links show imports/dependencies. Physics-based layout with repulsion, attraction, and orbit controls.
- **Cyberpunk Aesthetic** — Glow, starfield background, node sizing based on folders, link opacity/width tuning.
- **Deep Customization** — Adjust everything:
  - Max Depth, Node Size Scale, Folder Boost
  - Glow intensity, Link Opacity & Width
  - Charge Strength, Focus Distance, Orbit Speed
  - Star Count & Spread for the cosmic backdrop
- **Explorer & Inspector Panels** — Hierarchical file tree + detailed node previews.
- **Controls** — Mount Folder, Parse, Reconnect, Reset View, Expand/Collapse, Reheat simulation, Fit View, Show Connected View.
- **Client-Side Only** — No server needed; runs entirely in your browser (using modern Web APIs).

Built for developers who want to *see* their codebase like a living neural network.

## Tech Stack

- **Frontend**: TypeScript + JavaScript
- **3D Rendering & Physics**: Three.js (likely with a force-directed graph lib like 3d-force-graph or similar)
- **Build/Deploy**: Vercel (static/client-side app)
- **Local Runner**: Windows batch scripts for easy dev/standalone launch
- Languages: ~51% TypeScript, ~29% JavaScript, ~19% Batch, ~2% HTML

## Quick Start (Live)

1. Visit https://webula-final-repo.vercel.app
2. Click **Mount Folder** and select a project directory (give browser permission)
3. Click **Parse** to build the graph
4. Explore! Tune sliders in the **View** panel, orbit with mouse, select nodes for Inspector details.

*Note*: Currently works best on small-to-medium projects (<400 files). Large codebases may hit browser memory/performance limits.

*Note*: The hosted site can only talk to a local Ollama server if that Ollama instance allows the site origin through CORS. If you want `https://www.webulacode.com` to reach your local Ollama, start Ollama with `OLLAMA_ORIGINS=https://www.webulacode.com` on the machine running Ollama, then restart it. Otherwise, run Webula locally.

## Running Locally

### Windows (easiest)

```bash
# Clone the repo
git clone https://github.com/jaden688/webula-final-repo.git
cd webula-final-repo

# Dev mode (hot-reloading, if set up)
start-webula-dev.bat

# Or standalone/production-like
start-webula-standalone.bat
