<!--
  Thanks for sending a PR. FrogTalk is pre-alpha — see CONTRIBUTING.md for
  branch workflow (dev → master) and review expectations.
-->

### Summary

<!-- One paragraph: what problem does this solve, and how? -->

### Linked issue / report

<!--
  Fixes #
  Closes #
  Bug-report ID from /security (for security fixes):
-->

### Type of change

- [ ] 🐛 Bug fix (non-breaking)
- [ ] ✨ New feature (non-breaking)
- [ ] 💥 Breaking change
- [ ] 🔐 Security fix — include a PoC or `/security` report ID
- [ ] 📖 Docs / chore only

### Target branch

- [ ] **`dev`** (default for feature work)
- [ ] **`master`** (production hotfix only)

### Sanity checks

- [ ] `node --check node/static/js/<file>.js` passes for every JS file I touched
- [ ] `python3 -m py_compile node/<file>.py` passes for every Python file I touched
- [ ] I ran the app locally and exercised the changed code path
- [ ] No new secrets, tokens, or service-account JSON in the diff
- [ ] No new dependencies — or justified in the description

### Known gaps / follow-ups

<!--
  Anything deliberately out of scope for this PR.
-->

### Screenshots / before-after (if UI)

### Credit

- [ ] I've added myself to `CONTRIBUTORS.md` in this PR (or I'm already there).
