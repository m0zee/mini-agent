---
name: other-name
description: A skill whose frontmatter name deliberately differs from its containing directory name.
---

This fixture exercises the directory-mismatch WARN diagnostic: the skill
still loads successfully, but its stored name is "other-name", not
"mismatch-dir".
