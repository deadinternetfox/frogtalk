---
name: 🤖 Slop sighting
about: You spotted AI-written code that looks obviously wrong or unsafe
title: "[slop] "
labels: ["slop-sighting", "deslop-needed"]
---

<!--
  Use this for code that's clearly AI slop and clearly needs a human pass.
  Examples: dead variables, misleading comments, suspicious string
  handling, unused dependencies, copy-pasted patterns that don't match
  the rest of the codebase, docstrings that lie about what the code does.

  This is not a place to dunk on contributors — it's a place to surface
  things the deslop pipeline missed. Be specific, be kind.
-->

### Where

<!-- File path + line number, or a GitHub permalink. -->

### What looks off

<!-- Quote the offending block in a code fence, then describe the problem. -->

```
paste the code here
```

### Why it matters

<!--
  Pick all that apply:
  - [ ] Security risk (explain — but don't post a working PoC for unfixed vulns)
  - [ ] Correctness bug (the code lies about what it does)
  - [ ] Dead / unused code clutter
  - [ ] Misleading comment or docstring
  - [ ] Unsafe pattern that disagrees with the rest of the codebase
  - [ ] Performance footgun
  - [ ] Other (explain)
-->

### Suggested deslop

<!-- Optional. If you have a fix in mind, sketch it here or open a PR. -->
