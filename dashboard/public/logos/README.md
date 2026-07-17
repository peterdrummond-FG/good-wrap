# Company logos

Drop one logo per company here, named after its `slug` (see the `companies`
table / `GET /api/companies`), as a `.png`:

- `flippen-group`
- `teachworthy`
- `teamalytics`
- `capturing-kids-hearts`
- `integrous`
- `galleria`
- `maisey`

Any company added later just needs a matching `{slug}.png` here — no code
change required. Until a file exists for a given slug, `CompanyTag.vue` falls
back to a colored initials badge, so the app works fine with these missing
(currently true for `integrous`).

Square logos work best (rendered at 20x20 with `object-fit: contain`). Files
in this folder are served as-is at `/logos/{filename}` by Vite.
