# Overlay landing page

Preview: open `index.html` in any browser (no build step, works offline). Plain HTML, CSS and JS; images live in `assets/`.

Host free on GitHub Pages: GitHub Pages can only serve a branch's root or `/docs` folder, so for this `web/` folder go to **Settings > Pages > Source: GitHub Actions** and add a workflow that runs `actions/upload-pages-artifact` with `path: web` followed by `actions/deploy-pages` (or copy these files into `/docs` and pick "Deploy from a branch: main, /docs"). The site will be at https://ridhamjain28.github.io/Overlay/, which is the URL the link-preview tags in `index.html` point to.
