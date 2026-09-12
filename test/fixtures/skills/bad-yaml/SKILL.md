---
name: bad-yaml
description: A skill with intentionally broken frontmatter that the quote-and-retry fallback cannot recover.
metadata:
	author: broken
---

This body is unreachable: the frontmatter above uses a tab character to
indent a nested metadata key, which YAML forbids. The parser's fallback only
rewrites the description line, so this failure is not recoverable.
