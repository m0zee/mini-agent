---
name: unexpected-field
description: A skill with an extra top-level frontmatter field to exercise the lenient unexpected-field warning.
foo: bar
---

This fixture's frontmatter is otherwise valid; "foo" is not one of the
spec-recognized keys, so it should produce a WARN diagnostic without being
skipped.
