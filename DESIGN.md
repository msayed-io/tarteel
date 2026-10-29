# Tarteel (تَرتيل) — Design System v1.3
Desktop Quran player · Dark only · RTL-first · Apple Liquid Glass language (iOS 26 / macOS 26, refined in iOS 27 / macOS 27)

The reference implementation is `tarteel.html` (single file, no dependencies). It is the source of truth for every value in this document: if the two ever disagree, the HTML wins and this file must be corrected.

## 1. Principles
1. **Two layers (Apple HIG).** Glass is for the *functional layer* only: toolbar, tabs, search, icon buttons, the player. Content (lists, titles, covers) is flat and never glass.
2. **No glass on glass.** Anything that sits *on* a glass surface (the transport buttons inside the player) uses flat fills / transparency only, never its own glass or rim.
3. **One glass variant.** Use "Regular" everywhere. Never mix Clear and Regular.
4. **Quiet by default.** No ornaments, no Islamic patterns, no gradients as decoration (the brand mark and covers are flat fills). One accent, used only for "what is playing" and "favorited".
5. **Concentric shapes.** Every radius is derived from its container: `inner radius = outer radius − inset`. Capsules = full radius.
6. **Content scrolls under glass.** The toolbar and player float; the list passes beneath them and is blurred.

## 2. Color (dark)
| Token | Value | Use |
|---|---|---|
| --bg | #0A0B0D | Window background |
| --surface | rgba(255,255,255,.045) | Content group (list) |
| --hairline | rgba(255,255,255,.07) | 1px content border (not a rim) |
| --text | #F5F5F7 | Primary |
| --text-2 | rgba(245,245,247,.62) | Secondary |
| --text-3 | rgba(245,245,247,.50) | Tertiary / inactive (≈4.9:1 on --bg, passes WCAG AA; was .38 ≈ 3.3:1) |
| --accent | #5AA9FF | Now playing, favorite, seek fill, focus ring |
| --accent-soft | rgba(90,169,255,.14) | Cover background of the active row |
| --glass | rgba(30,32,37,.58) | Glass tint |
| --glass-hover | rgba(58,61,69,.55) | Glass tint on hover |
| --rim-base | rgba(255,255,255,.10) | Uniform base of the specular rim |

No purple. No green/gold "Islamic" palette. Background gets one faint white radial at the top only (`radial-gradient(900px 520px at 50% -8%, rgba(255,255,255,.055), transparent 70%)`).

## 3. Typography
Stack: `SF Arabic, Segoe UI Variable Text, Segoe UI, Noto Sans Arabic, system-ui`.
**No letter-spacing anywhere on Arabic text** (a non-zero value breaks the cursive joins). The 40px title therefore has none.
| Role | Size / Weight |
|---|---|
| Page title | 40 / 700 |
| Row title, player title | 15 / 600 |
| Secondary, tabs, search | 13–14 / 400–500 |
| Time, duration | 11–13, tabular numerals |
Arabic-Indic digits (٠-٩) everywhere in UI text. Counts use correct Arabic plural forms: لا توجد تلاوات · تلاوة واحدة · تلاوتان · ٣–١٠ تلاوات · ١١+ تلاوة.

## 4. Shape & spacing
Radius tokens: 12 (player cover) · 20 (rows) · 28 (list group) · 34 (player) · 999 (capsules, circles).
Row cover radius = **20 − 10 = 10** (concentric inside the row; derived, not a token).
Spacing grid 4/8: gaps 8, 12, 16; page padding 32; toolbar inset 16×24.
Content max-width 1040. Minimum window width 720.
Toolbar controls are exactly **44px** high: tabs = 4 padding + 36 buttons + 4 padding. Transport 40px, play hit target 48px. Slider hit area 30px high; its visual track is 8px at rest and 12px while dragging. Row = 68px (10 + 48 + 10).

## 5. Liquid Glass recipe (project-specific web approximation)

### Research basis (official Apple sources checked October 29, 2026)
- **Apple WWDC25 — “Meet Liquid Glass” (session 219).** Apple describes a functional layer for navigation and controls, geometry-aware lighting/highlights, shadows that strengthen over text, and the principle to avoid stacking glass over glass. It explains the `regular` and `clear` variants and recommends using Clear only over visually rich content. See [the official session](https://developer.apple.com/videos/play/wwdc2025/219/).
- **Apple Human Interface Guidelines — Materials.** The current guidance says Liquid Glass should distinguish controls/navigation from the content layer and should be used sparingly; ordinary content belongs on standard materials. See [Materials](https://developer.apple.com/design/human-interface-guidelines/materials).
- **WWDC26 — Platforms State of the Union / current 2027 OS design.** Apple describes improved diffusion behind glass, a darker edge, brighter specular highlights, and a user-facing control for changing the material from clearer to more tinted. These platform refinements are part of Apple's native rendering, not a published CSS formula. See [Platforms State of the Union](https://developer.apple.com/videos/play/wwdc2026/102/) and [Apple's iOS 27 overview](https://developer.apple.com/ios/whats-new).
- **Important precision note.** Apple does not publish the exact one-pixel CSS ring, these gradient stop values, or this corner-anchor equation as a web implementation recipe. The values below are Tarteel's carefully controlled approximation inspired by Apple's documented principles; they are **not** a claim to reproduce Apple's private/native rendering pixel-for-pixel. The official sources reviewed do not support the older statement that iOS 27 removed motion-driven native highlights, so that claim has been removed.
- **Consequence for this design.** For visual stability in a desktop web reference, the highlight is intentionally static: a brighter source near the top-left corner arc and a weaker one near the bottom-right, both fading along the rim over a dark outer edge. This is our design decision, not an assertion that Apple's native material is static. The list remains a flat content layer; the toolbar and player are the functional glass layer. (The interaction/layout treatment in §5b is a web-specific choice, not a literal port of native scroll-edge effects.)
### Parts of every glass capsule
1. **Body:** `background: rgba(30,32,37,.58); backdrop-filter: blur(36px) saturate(180%)`
2. **Dark outer edge:** `box-shadow: 0 0 0 1px rgba(0,0,0,.42), 0 10px 32px rgba(0,0,0,.38)` — sits *outside* the box.
3. **Specular rim:** `::before`, `inset:0`, `border-radius:inherit`, `padding:1px`, masked to a ring
   (`mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); mask-composite: exclude`). It occupies exactly the outermost 1px of the border box: not outside, not inside. Fill, bottom to top:
   - uniform base edge `rgba(255,255,255,.10)`
   - `radial-gradient(circle 50px at P2, white .55 → 0)` bottom-right highlight
   - `radial-gradient(circle 50px at P1, white .92 → 0)` top-left highlight
   Both radials use the same 7-stop eased falloff (0, 12, 26, 42, 60, 80, 100%), so the highlight has no banding and is the **same size on every capsule** whatever its aspect ratio.

### Highlight anchoring (the key correction in v1.1)
The highlights are anchored to the **middle of the corner arc (its 45° point)**, not to the bounding-box corner. A bounding-box corner lies off the ring (≈ 9px away on a 44px capsule), so the peak never reached the rim and the highlight looked like a uniform outline.
```css
.glass      { --rr: 22px;                 /* the element's real corner radius */
              --k: calc(var(--rr) * .2929); }   /* 1 − cos 45° */
.glass.big  { --rr: 34px; }
/* P1 = var(--k) var(--k)                                   → top-left arc midpoint  */
/* P2 = calc(100% - var(--k)) calc(100% - var(--k))         → bottom-right arc midpoint */
```
`--rr` must equal the element's actual radius (height ÷ 2 for capsules/circles). Corners are anchored physically (left/top), so the light stays top-left in RTL.

**Apply the specular rim to:** brand capsule, tabs, search, and the circle buttons of the toolbar.
**Do not apply to:** transport buttons (they are flat on the player glass, principle 2), list, rows, covers, page title.
**Large surface (player capsule):** class `glass big` replaces the rim with a quiet uniform `rgba(255,255,255,.07)` edge and uses `--rr:34px`.
Capsule interaction: hover → tint +; press → `scale(.94)` over .35s `cubic-bezier(.32,.72,0,1)`. Reduced motion disables animation. Player controls use the supplied `dynamic-island-mac.html` interaction language: solid skip glyphs, play/pause crossfade (`opacity .22s`, `scale .3s`), press `scale(.88)` + `opacity:.7` over `.2s` using `cubic-bezier(.2,.9,.3,1)`. The play control is a flat glyph on the player surface, not a nested white disc.

### System accessibility settings
- `prefers-reduced-transparency: reduce` → glass tint `rgba(30,32,37,.96)`, no backdrop-filter, **where the browser supports this media feature**. As of October 2026, support is not universal (notably Safari); verify the actual runtime, and offer an in-app opaque-glass preference if cross-browser parity is required. Reference: [MDN browser-compatibility note](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/%40media/prefers-reduced-transparency).
- No `backdrop-filter` support → same opaque fallback (`.94`).
- `prefers-contrast: more` → rim base `.45`, player edge `.30`, `--text-3` raised to `.72`.
- `prefers-reduced-motion: reduce` → no animation or transition; equalizer bars become static (7 / 12 / 9px).

## 5b. Scrolling & floating behavior
- Toolbar (`position:fixed`, grid `minmax(0,1fr) auto minmax(0,1fr)`) and player (`position:fixed`) never move. The page scrolls; rows pass **under** each capsule and are blurred by it. Nothing sits behind the capsules (no bars, no fades).
- The toolbar container has `pointer-events:none`; only the capsules receive input, so the gaps between them stay see-through and clickable-through.
- Every toolbar element is a capsule (brand included), so no text ever collides with scrolling content.
- Page bottom padding 168px so the last row clears the player. `html{scrollbar-gutter:stable}` so fixed elements do not shift when the scrollbar appears.

## 6. Layout (1440×900 reference, fluid)
```
[brand capsule]    [ المكتبة | المفضلة ]    [search][import][settings]   ← floating toolbar
                      المكتبة (title = active tab)
                      N تلاوات
                 ┌───────── list group ─────────┐
                 │ cover  title · note   dur  ♥ │ rows 68px, active row tinted
                 └──────────────────────────────┘
       ┌────────── floating player capsule (900) ──────────┐
       │ cover+title      ⏮  ⏯  ⏭        volume            │
       │ time ────────────●────────────── time              │
       └───────────────────────────────────────────────────┘
```
Brand at the start (right), actions at the end (left). Transport row is always LTR. Player is `min(900px, 100% − 48px)`; its grid is `minmax(0,1fr) auto minmax(0,1fr)` so the title never pushes the controls and the transport stays centered. Below 820px: hide search, volume, and the page subtitle (the count).

## 7. Components
- **Tabs:** segmented capsule (`role="group"`, buttons with `aria-pressed`); selected = `rgba(255,255,255,.14)` pill. Two tabs only (المكتبة، المفضلة). The page title follows the active tab.
- **Row:** `div.row` containing two sibling buttons (no nested interactive elements): `button.hit` (cover 48 · title+reciter · duration) and `button.fav` (heart). Active row: tint `rgba(255,255,255,.07)`, title in accent, cover background `--accent-soft`, 3-bar equalizer while playing, surah number otherwise.
- **Player controls (updated from `dynamic-island-mac.html`):** previous/next use solid double-triangle glyphs; play/pause use solid glyphs that crossfade and scale rather than swapping abruptly. Buttons press to `scale(.88)` and `opacity:.7`; no glass or raised surface is added inside the glass player. Both seek and volume use the same neutral scrubber: `--control-fill:#9d9da1`, active fill `#e6e6ea`, track `rgba(235,235,245,.3)`, 8px resting height and 12px while dragging. The visual track animates between heights over `.25s cubic-bezier(.2,.9,.3,1)`. The full slider hit area is 30px tall; the thumb remains visually hidden. Tarteel’s blue accent remains reserved for the current recitation, favorites, and keyboard focus.
- **Empty states:** one line of text, no illustration. Search with no match: «لا توجد نتائج». Empty favourites: «لم تُضف أي تلاوة إلى المفضلة بعد».
- **Icons:** 24px grid, 1.75 stroke, round caps/joins, SF Symbols-like (filled for transport, outline for the rest). One family only.

## 8. Behavior & states
- Click row = play; heart toggles favorite; المفضلة filters; keyboard focus ring = 2px accent, 2px offset (the search capsule shows it via `:focus-within`; sliders keep their ring).
- **Search** matches surah number, surah name, note and reciter independently (not across field boundaries), ignoring tashkeel/tatweel, alef-hamza forms (أ إ آ ا), ى/ي, ة/ه, and Arabic-vs-Western digits («الاعراف» finds «الأعراف»; «30» finds «٣٠»).
- **Next / previous** follow the list currently shown (library, favourites or search result). Previous restarts the track if more than 3s have played. When a track ends, the next one starts.
- **Space** toggles play/pause when nothing else has focus. Seek and volume respond to pointer input and keyboard range controls; dragging either slider expands its track and brightens the fill, then smoothly returns to rest on release/cancel/blur.
- The play button's `aria-label` switches between «تشغيل» and «إيقاف مؤقت»; each heart is labelled with its track.

## 9. Implementation notes for the builder
- Reproduce `tarteel.html` exactly; tokens above are the CSS variables in `:root`.
- **Prototype boundary:** the sample recitations have no bundled audio URLs. Playback progress is simulated; seek and volume currently update the visual state only. The Import and Settings toolbar buttons are visual placeholders. Treat this as a self-contained UI/interaction reference, not a production-ready audio engine. In the real app, connect licensed/authorized recitation sources, actual media playback, persistence, import behavior, and settings without changing the documented visual hierarchy.
- **Never reuse an `id` for an SVG `<symbol>` and a control.** In v1.0 the symbols `prev`, `next` and `vol` had the same ids as the buttons/slider, so `querySelector("#prev")` returned the symbol and the previous/next buttons and the volume slider were dead. Symbols are now prefixed `ic-`.
- Windows/Electron/Tauri: `backdrop-filter` works in Chromium/WebView2. Keep the window background `#0A0B0D`. Native Mica is optional and must not replace the CSS glass.
- **Screenshots/CI:** headless Chromium without GPU may not render `backdrop-filter`, so glass can look less blurred and text behind it can show through. Use a real GPU-backed browser/window or test the target Electron/WebView runtime before judging the material.
- **Icons:** the inline SVGs in this file are a custom, single-family outline set, not official SF Symbols assets. Apple's published guidance describes SF Symbols as a consistent system library with weights/scales and localized direction handling; for a native Apple build, prefer supported system symbols. For this dependency-free web file, keep one consistent SVG grid, stroke, cap/join treatment, and explicit RTL/LTR behavior. See [Apple's SF Symbols HIG](https://developer.apple.com/design/human-interface-guidelines/sf-symbols) and [Design Resources](https://developer.apple.com/design/resources/).
- Do not add colors, patterns, or extra glass surfaces. When unsure, remove.

## 10. Changelog v1.0 → v1.1 (design unchanged; defects fixed)
**Bugs**
1. Previous/next buttons and the volume slider did nothing (duplicate ids, see §9).
2. Specular highlight peak missed the ring (anchored to the bounding-box corner); now anchored to the corner-arc midpoint via `--rr` / `--k`.
3. Player title was truncated («…الأو») because the side columns were `1fr` with nowrap content; player widened to 900, columns `minmax(0,1fr)`, sample title shortened.
4. Spec said transport buttons carry the rim; the HTML had them flat. Resolved in favour of the HTML (Apple: no glass on glass); the nested `backdrop-filter`, `!important` overrides and hidden `::before` were removed.
5. 40px page title used `letter-spacing:-.01em`, contradicting the no-Arabic-letter-spacing rule and degrading joins.
6. Tabs were 45px high next to 44px controls (line-height); now exactly 44.
7. Brand mark and covers used decorative gradients (against principle 4); now flat. `--accent-soft` was defined but unused; now used for the active cover. Row cover radius made concentric (10).
8. Sliders lost their focus ring (`outline:0`); Firefox showed a default thumb; hit area was 4px. Fixed (20px hit area, `-moz-` rules, ring restored).
9. Page title always read «المكتبة»; now follows the tab. Count used «١ تلاوات»; now correct plural forms.
10. Search ignored alef/hamza/tashkeel/digit variants and matched across field boundaries; next/prev ignored the active filter; a finished track never advanced; reduced-motion hid the equalizer; rows were `role=button` with nested buttons and no keyboard activation; play button label never changed.
11. `--text-3` raised from .38 to .50 for AA contrast; the 820px breakpoint now also hides the subtitle, as documented.
12. Added reduced-transparency, increased-contrast and no-backdrop-filter fallbacks; empty states; `scrollbar-gutter`; sample note «تلاوة مجانية» replaced by «تلاوة مرتّلة».


## 11. Changelog v1.1 → v1.2 (design unchanged; audit fixes)
1. Fixed search matching across concatenated fields: the normalized surah name, note, reciter, and number are now searched independently so a query cannot accidentally span the boundary between two different fields.
2. Added polite live announcement for the recitation count, improving feedback for assistive-technology users without changing the visual layout.
3. Prevented holding Space from repeatedly toggling play/pause due to key auto-repeat; modifier-key combinations no longer trigger the player shortcut.
4. Rechecked the Liquid Glass research notes against current Apple primary sources. Removed the unsupported claim about native iOS 27 motion-driven highlights being removed; clarified which details are Apple principles and which are Tarteel's web-specific visual approximation.
5. Documented the current prototype boundary: the HTML has simulated playback and presentational Import/Settings buttons until real audio and product behavior are connected.

## 12. Changelog v1.2 → v1.3 (controls updated, page layout retained)
1. Ported the supplied Dynamic Island reference’s solid previous/next glyph language into the Tarteel player, scaled for the existing compact transport layout.
2. Replaced the abrupt play/pause icon swap with an overlapping opacity/scale transition and copied the tactile press response (`scale(.88)`, opacity `.7`, `.2s`, `cubic-bezier(.2,.9,.3,1)`). The player buttons remain flat on the glass surface.
3. Reworked the seek and volume tracks to share the reference’s animated 8px resting / 12px active track, neutral gray fill, brighter active fill, and `.25s` easing. Both tracks use the same 30px interaction area and return smoothly to rest after pointer release/cancel/blur.
4. Preserved Tarteel’s RTL layout, blue identity accent, slider values, accessible names, and the existing simulated playback behavior. The seek bar remains LTR so time progresses left-to-right, matching the player reference.

## 13. Official references
- Apple, [Meet Liquid Glass — WWDC25, session 219](https://developer.apple.com/videos/play/wwdc2025/219/).
- Apple, [Human Interface Guidelines: Materials](https://developer.apple.com/design/human-interface-guidelines/materials).
- Apple, [Platforms State of the Union — WWDC26](https://developer.apple.com/videos/play/wwdc2026/102/).
- Apple, [What’s new in iOS 27](https://developer.apple.com/ios/whats-new).
- Apple, [Human Interface Guidelines: SF Symbols](https://developer.apple.com/design/human-interface-guidelines/sf-symbols).
- Apple, [Design Resources](https://developer.apple.com/design/resources/).
