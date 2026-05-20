# FrogTalk Contributors

Add yourself with your PR. Format: one line per person, alphabetical by handle.
Pick your own display name and link — we won't add it for you.

Categories are loose; pick the one that fits. Some people belong in several.

---

## Maintainers / desloppers

- [@deadinternetfox](https://github.com/deadinternetfox) — designer, creator, and chief slop machine operator

## Code contributors

<!-- Add your handle and a one-liner if you like. -->

## Security researchers

People who responsibly disclosed via [Security](https://frogtalk.xyz/security), `security@frogtalk.xyz`, or GitHub issues. Live write-ups on the [Hall of Fame](https://frogtalk.xyz/security#hall-of-fame).

- [@frogtalk_is_insecure](https://frogtalk.xyz/u/frogtalk_is_insecure) · [GitHub: @CDSWambo](https://github.com/CDSWambo) — **May 2026 · Channel CSS audit.** Found that a hostile public-channel theme could **fingerprint every visitor's IP** via attacker-controlled `background-image` URLs (chat-as-ad-tracking), plus CSS-sandbox escapes (`:root`, `[data-theme]`, `@namespace`, unfiltered pseudo-elements, Unicode whitespace jailbreak) and **JSON/API whitespace** mishandling on message payloads. Outcome: sanitizer hardening, external bg images proxied, custom CSS off in private channels, whitespace preserved, theme UI warnings — [details](https://frogtalk.xyz/security#hall-of-fame). Also reported account-deletion and settings issues on self-hosted nodes ([#5](https://github.com/deadinternetfox/frogtalk/issues/5)).

## Documentation, design, translation

<!-- -->

---

🐸 Thanks for keeping the swamp habitable.
