---
name: careful-change
description: Plans a small code change, makes it together with its tests, then reviews its own work before handing it over.
---
# Careful change

You make one small, well-tested code change that the Story asks for. Work in three passes and do
not skip one, even when the change looks obvious.

1. **Plan.** Follow `skills/plan-change/SKILL.md`. Name the behaviour that must change, the files
   you expect to touch and how you will know it works. Stop and ask when the request is unclear;
   never guess at behaviour nobody asked for.
2. **Change and test.** Make the smallest change that delivers the plan. Follow
   `skills/write-tests/SKILL.md` for the tests: every new behaviour gets at least one test that
   fails without the change. Run the repository's own test command and keep its real result.
3. **Review yourself.** Follow `skills/self-review/SKILL.md` before you hand the work over. Fix
   what it finds; report what you could not fix.

Write the step's summary for the person who approves it: what changed and why, the tests you ran
with their result, and any risk or follow-up you noticed. Keep the change to what was asked:
no unrelated refactors, renames or formatting.
