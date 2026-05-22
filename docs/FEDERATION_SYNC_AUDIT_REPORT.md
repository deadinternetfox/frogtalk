# Federation sync polish — audit report

_Date: 2026-05-22 (re-audit after collision handling + client resume fix)_  
_Verdict: **APPROVE** — P0 security pass; automated matrix green; manual QA remains operator checklist_

---

## Plan track status (A–H + collisions)

| Track | Status | Notes |
|-------|--------|-------|
| A Persistent sync state | **DONE** | `user_federation_sync_state`, `FROGTALK_SYNC_PERSIST`, restart reload |
| B Home URL binding | **DONE** | `_resolve_sync_source_base`, ignores client `source_base` when pinned |
| C1 Export verification | **DONE** | gid / `source_server_id` / URL checks before apply |
| C2 Export signing | **DONE** | `sign_sync_export` / `verify` via `get_federation_server_pubkey` |
| D Auto-resume login | **DONE** | Password + ticket login; client `ensureFederationSyncOnLogin` uses `force: false` resume |
| E Pagination | **DONE** | 300/page cursor loop; export + apply |
| F Stale TTL | **DONE** | `FROGTALK_SYNC_STALE_HOURS` (default off) |
| G/G2 UI + profiles | **DONE** | Network panel, FrogSocial banners, roster hydrate |
| H Docs + flags | **DONE** | `SECURITY_MODEL.md`, `NODE_INSTALL.md`, rollback table |
| **Collisions** | **DONE** | Nick / channel / vanity disambiguation; status counters in UI |
| **Co-located calls** | **DONE** | `callee_session_on_local_node` → local ring when WS online here |

**Not automated (operator manual QA §14.2):** 350-post traveler scenario, mid-restart soak, DevTools tamper — checklist below.

---

## P0 Security

| ID | Result | Evidence |
|----|--------|----------|
| S-B1 | **PASS** | `_resolve_sync_source_base()`; `test_resolve_sync_source_uses_pinned_home` |
| S-B2 | **PASS** | Sync/profile fetches via `_post_json` / `_get_json` + `_ssrf_guard` |
| S-C1 | **PASS** | `_verify_sync_export()` in apply loop; `test_verify_sync_export_rejects_wrong_home` |
| S-C2 | **PASS** | Home repin `force=False`; signature verify; no repin on mismatch |
| S-D1 | **PASS** | Foreign login resumes incomplete sync; does not clear persisted state at home |
| S-E1 | **PASS** | Encrypted posts without wraps omitted + counted |
| S-F1 | **PASS** | `export-gid` / `profile-gid` require federation token |
| S-G1 | **PASS** | Profile hydrate: directory URL, SSRF, rate limit, no session token |
| S-H1 | **PASS** | Peer sync: `X-Federation-Token` only |
| S-I1 | **PASS** | resume 30/h, reset 12/h, export 120/h (unchanged) |
| S-J1 | **PASS** | Federated mirror does not attach `global_user_id` to unrelated local nick (`test_ensure_federated_dm_does_not_hijack_native_local_nick`) |
| S-K1 | **PASS** | Local channel name owned by community user → no join; directory index only |

---

## Architecture

| ID | Result | Notes |
|----|--------|-------|
| A-1 | **PASS** | Shadow home resolution ordering preserved |
| A-2 | **PASS** | Feed reads local SQLite only |
| A-3 | **PASS** | Idempotent social apply / wall map |
| A-4 | **PASS** | `test_federated_wall_post_after_shadow_user` |
| A-5 | **PASS** | `/api/auth/me` → `at_home_node`, `account_home_base_url` |

---

## UX / client

| ID | Result | Notes |
|----|--------|-------|
| U-1 | **PASS** | Network panel: home, sync summary, collision counts |
| U-2 | **PASS** | `isAtHomeNode()` uses server `at_home_node` only (no “no URL = home” fallback) |
| U-3 | **PASS** | FrogSocial never-synced / partial / omitted banners |
| U-4 | **PASS** | Roster federation profiles + hydrate |
| U-5 | **PASS** | `probeAccountSyncIfSparse` / `ensureFederationSyncOnLogin` pass `force` correctly to resume API |

---

## Automated tests

```
pytest tests/test_federation_sync.py tests/test_federated_calls.py -q
54 passed (re-audit run)
```

Coverage highlights: persist state, pagination 350+, sign/verify export, login resume/skip, stale TTL, collisions, shadow user regression.

---

## Blockers

None.

---

## Nits (non-blocking)

1. **`FROGTALK_SYNC_STALE_HOURS`** default `0` — enable `24` on busy foreign nodes after soak.
2. **Lazy profile fetch** inline in room members (4s cap) — move to background if latency spikes.
3. **Same nick + same password** on foreign node still logs into the **local** account first (per-node credentials); document for support; gid-aware login is a future enhancement.
4. **§14.2 manual QA** not executed in CI — use checklist below before major release.

---

## §14.2 Manual QA checklist (record results when run)

| # | Step | Pass? | Notes |
|---|------|-------|-------|
| 1 | Home **H**: register, 350 wall posts, 3 channels, 2 DMs | | |
| 2 | **F**: password login (not boot) → auto sync | | |
| 3 | Restart **F** mid-sync → resumes | | |
| 4 | Feed on **F** shows >300 posts | | |
| 5 | New post on **H** appears on **F** (live federation) | | |
| 6 | Member avatars on **F** | | |
| 7 | Re-sync: no duplicate posts | | |
| 8 | DevTools tamper `source_base` → server still uses **H** | | |
| 9 | **F** has local channel same name as home → federated listing, not wrong join | | |
| 10 | **F** has local user same nick as home contact → DM works under remapped nick | | |

---

## Feature flags (rollback)

| Env | Default |
|-----|---------|
| `FROGTALK_SYNC_PERSIST` | 1 |
| `FROGTALK_SYNC_BIND_HOME` | 1 |
| `FROGTALK_SYNC_VERIFY_EXPORT` | 1 |
| `FROGTALK_SYNC_SIGN_EXPORT` | 1 |
| `FROGTALK_SYNC_LOGIN_RESUME` | 1 |
| `FROGTALK_SYNC_PAGINATION` | 1 |
| `FROGTALK_SYNC_STALE_HOURS` | 0 (off) |

---

## Verdict

**APPROVE** for merge from a security and automated-test perspective. Complete §14.2 manual QA on a staging pair (H + F) before production traveler rollout.
