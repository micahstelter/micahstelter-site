# micahstelter-site

Personal website for Micah Stelter — micahstelter.ai

## Structure

- `index.html` — Landing page with auto-populated tools grid
- `404.html` — Custom 404 page
- `tools/manifest.json` — Registry of published tools/dashboards
- `tools/<slug>/index.html` — Individual tool pages

## Publishing a tool

Add a new folder under `tools/` with an `index.html`, then add an entry to `tools/manifest.json`. The homepage reads the manifest and displays all tools automatically.
