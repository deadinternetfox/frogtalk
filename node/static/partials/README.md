# Static partials

Shared HTML fragments for marketing / docs pages (no build step).

| File | Loaded by |
|------|-----------|
| `site-footer.html` | `/static/js/site-footer.js` → `#ft-site-footer-mount` |

**Usage on any static page** (before `</body>`):

```html
<div id="ft-site-footer-mount"></div>
<script src="/static/js/site-footer.js?v=1" defer></script>
```

Bump `?v=` on the script tag when you change the partial or `site-footer.css`.
