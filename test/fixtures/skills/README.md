# Skill discovery test fixtures

This file lives directly under test/fixtures/skills/, next to the skill
directories, not inside one of them. discoverSkills must ignore it entirely:
it is not a subdirectory, so it never becomes a discovery candidate.
