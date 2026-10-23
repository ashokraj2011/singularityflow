---
name: plan-change
description: Turn the request into a short plan of behaviour, files and checks before any code changes.
---
# Plan the change

Write a plan of at most five bullets before editing anything:

- **Behaviour:** what must be true after the change, in the words of the request.
- **Files:** the source and test files you expect to touch, and why each one.
- **Checks:** the tests you will add or change, and the command that runs them.
- **Out of scope:** anything nearby you will deliberately leave alone.
- **Open questions:** only what you cannot decide from the request or the code. Ask them first.

Read the code you plan to change before you plan it; a plan written from file names alone is a guess.
