---
'@fetchkit/ffetch': patch
---

Changed

- GitHub releases now include the exact npm tarball, signed SLSA build provenance, and an SBOM
- Release provenance is verified against the tarball before publishing to npm
- Migrated release automation to Changesets Action v2 with explicit GitHub App token handling
