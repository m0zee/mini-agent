---
name: no-description
license: MIT
---

This skill's frontmatter is valid YAML but has no description field at all,
which parse.ts must reject as an ERROR (missing description), not merely an
empty-string description.
