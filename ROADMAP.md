# Plexamp Classic Roadmap

Plexamp Classic is a Winamp 2.9-style macOS player with Plex playback, federation, MilkDrop, and desktop/windowed modes.

The roadmap prioritizes reliability and daily usability before adding more services. Spotify is deliberately not a near-term playback backend: Spotify can be integrated as a catalog/control surface, but its protected audio cannot legitimately become a normal Webamp media URL.

## Product priorities

1. **Never lose the user's queue or state.**
2. **Make a large Plex library pleasant to browse and search.**
3. **Behave like a proper macOS audio application.**
4. **Keep the Winamp character instead of turning into a generic media dashboard.**
5. **Add integrations only where the platform permits a reliable experience.**

---

## Phase 0 — Playback and state contract

Before polishing screens, define what the player promises.

- Decide queue semantics explicitly:
  - Replace playlist
  - Append album
  - Play next
  - Add individual track
- Define restart behavior:
  - Restore queue and current track
  - Restore playback position
  - Restore volume, shuffle, repeat, EQ, and visualization state
  - Do not autoplay unexpectedly unless the user enables resume-on-launch
- Add a stable internal track model with Plex server identity, rating key, stream URL, metadata, and expiry/rebuild information.
- Add error states for unavailable servers, expired stream URLs, deleted media, and failed track transitions.

**Acceptance:** Kill and relaunch during a queue, after a server disconnect, and while paused. The app restores a useful, truthful state without dead tracks or silent failures.

---

## Phase 1 — Retention across reboots

This is the highest-value reliability work.

Persist in the Electron user-data directory, not renderer-only transient state:

- Queue and queue order
- Current track identity and playback position
- Playing/paused state, with a safe resume policy
- Volume, mute, shuffle, repeat, EQ, and visualization settings
- Selected Plex server and music section
- Player mode: desktop panels or windowed
- Window bounds and desktop-panel layout
- Always-on-top setting
- Zoom factor
- Last library view, search term, selected artist, and selected album

Use versioned JSON state with atomic writes and corruption recovery. Avoid persisting raw `app-stream://` URLs as the sole identifier; regenerate them from the Plex server/rating key on restore.

**Acceptance:** Reboot the Mac with a populated queue, relaunch the app, and recover the queue, current item, controls, layout, and library context. A corrupt state file falls back cleanly instead of preventing launch.

---

## Phase 2 — Media Library GUI overhaul

The current library loads the full artist list and filters only artist names client-side. It is functional, but not pleasant at Plex-library scale.

### Navigation and layout

- Persistent left navigation for:
  - Artists
  - Albums
  - Recently added
  - Recently played, if Plex data supports it
  - Favorites/playlist shortcuts, if later added
- Breadcrumbs: server → section → artist → album
- Album grid/list toggle
- Album artwork with graceful fallback
- Clear `Play`, `Add`, and `Play next` actions instead of one ambiguous click
- Visible current queue/player status
- Preserve selection while navigating

### Search

- Search artists, albums, and tracks—not only artist names
- Debounced search with an explicit loading state
- Search scope selector: current server, current section, or all connected Plex sources
- Keyboard navigation and Enter-to-play
- Escape clears search; Cmd/Ctrl+F focuses it
- Empty, partial, and failed search states
- Fuzzy matching for punctuation, apostrophes, and diacritics

### Scale and performance

- Avoid rendering thousands of DOM nodes at once; use pagination or list virtualization
- Cache artist/album responses with invalidation
- Abort stale requests when the user changes selection quickly
- Consider a main-process library cache for faster startup and offline browsing
- Probe federated servers in parallel or expose connection progress; serial probing currently makes some shared-server connections slow

**Acceptance:** Search and browse a 2,500+ artist library smoothly, find an album by album title alone, and distinguish play/append/play-next without guessing.

---

## Phase 3 — Real macOS media integration

Basic media-key shortcuts already exist through Electron `globalShortcut`. Finish the platform integration instead of stopping there.

- Register with macOS Now Playing / MediaRemote where practical
- Publish:
  - Track title
  - Artist
  - Album
  - Artwork
  - Duration
  - Current position
  - Playback state
- Handle:
  - Play/pause
  - Next
  - Previous
  - Seek
  - Position changes
  - Volume where supported
- Ensure media keys work when the library window or another app has focus
- Avoid `unregisterAll()` collateral damage; register only this app's shortcuts and clean them up precisely
- Test keyboard media keys, Control Center, AirPods, lock screen, Touch Bar/keyboard controls where applicable

**Acceptance:** A Plex track appears correctly in macOS's Now Playing surface and can be controlled from media keys and AirPods without the library window being focused.

---

## Phase 4 — Queue and playback UX

- Make queue operations first-class: append, play next, remove, reorder, clear
- Show the active track and playback progress outside the tiny Winamp playlist where useful
- Preserve the queue when switching Plex servers
- Add retry/skip behavior for failed tracks
- Add “why did this fail?” diagnostics for stream proxy and TLS failures
- Decide whether album enqueue should start playback immediately or only add to queue
- Add optional gapless/crossfade behavior only after measuring Webamp limitations
- Add a lightweight playback history for local UX, independent of Plex scrobbling

**Acceptance:** Queue manipulation feels intentional and survives normal track errors, server changes, and app restarts.

---

## Phase 5 — Artwork, metadata, and Plex polish

- Album and artist artwork in the library and Now Playing integration
- Track numbers, disc numbers, year, genre, and duration
- Multi-disc album grouping
- Explicit handling for compilations and Plex's per-artist soundtrack quirks
- Context actions:
  - Open in Plex
  - Reveal server/album identity
  - Copy Plex URL
  - Rescan/request metadata only if explicitly added later
- Better server/section labels and connection diagnostics

**Acceptance:** A compilation, multi-disc album, federated server album, and ordinary album all display and queue correctly.

---

## Phase 6 — Configuration, packaging, and recovery

- Settings window for server/account, default section, behavior, appearance, and playback
- Export/import user settings and queue
- Clear cached account/library data without deleting unrelated app data
- Crash-safe state writes and startup recovery
- Version/update notification
- Reproducible clean-clone build check
- Signed and notarized release when a Developer ID identity becomes available
- Automated smoke test for packaged app: launch, login state, library load, queue, stream, media controls

**Acceptance:** A user can move to another Mac or recover after an app crash without manually reconstructing configuration.

---

## Phase 7 — Optional integrations

### Spotify: catalog and remote control

Reasonable scope:

- OAuth with a Spotify Developer application
- Search Spotify artists/albums/tracks/playlists
- Open a result in the official Spotify app
- Control an active Spotify device where the account/API permits it
- “Find this in Plex” for matching local media

Not in scope for the normal Webamp queue:

- Extracting Spotify audio URLs
- Feeding Spotify's protected playback into Webamp or MilkDrop
- Reverse-engineering the Spotify client

### Other possible sources

- Local files/folders, if a safe file picker and metadata model are desired
- Internet radio streams, with explicit URL/source handling
- Plex playlists, smart collections, and ratings

Each new source should implement the same internal queue contract rather than adding source-specific hacks to Webamp.

---

## Cross-cutting quality gates

- No credential or token leakage into renderer logs, Git, or packaged artifacts
- No raw server URLs or account state in public diagnostics
- Tests for queue persistence and corrupted state
- E2E test for Plex stream playback through `app-stream://`
- E2E test for album search and play-next behavior
- Test desktop-panel click-through after every player-window change
- Verify both desktop and windowed modes at fractional zoom levels
- Keep public-repo hygiene: `.env`, Plex auth state, and local preset packs remain excluded

## Suggested first implementation slice

1. Add a versioned persistent player/session state store.
2. Refactor the library into explicit `Play`, `Add`, and `Play next` actions.
3. Add album/track search with debouncing and request cancellation.
4. Add artwork and a real selected/current-track state.
5. Replace the current media-key-only integration with Now Playing metadata and command handling.

That sequence improves the daily experience without committing the project to a second protected streaming backend prematurely.

## Next implementation slice after v0.5.0

The v0.5.0 search tree now provides artist-first results, lazy artist discographies, Plex release-group branches, keyboard traversal, and album/track activation. The current working tree adds View-menu checkboxes for player panels, panel-state IPC, and `⌘L` protection, but that slice still needs to be landed and exercised before building on it. The next feature slice should make library selections compose with the Winamp queue instead of always replacing it.

### 1. Close the View-menu and panel-control slice

**Priority:** prerequisite / P0

- **Milestone:** Verify and land the existing `main.js`/`player.js`/`preload.js` changes without expanding their scope. Keep the main player non-toggleable, keep menu checkmarks synchronized after Webamp panel changes, and ensure opening/closing the Media Library rebuilds the menu state.
- **Acceptance:** Toggling Playlist, Equalizer, or MilkDrop from View changes the actual Webamp panel and its checkmark; toggling a panel inside Webamp updates the checkmark; the main player remains visible; `⌘L` opens/closes only the library; relaunch restores panel visibility and the selected player mode.
- **Likely files:** `main.js`, `player.js`, `preload.js`, `session-state.js`, `test/session-state.test.js` (plus a small extracted menu/panel helper if unit coverage cannot safely load Electron).
- **Verification:** `npm test`, `git diff --check`, `node --check main.js player.js preload.js`; packaged/manual E2E in both desktop and windowed modes covering all View items, `⌘L`, panel persistence, and desktop click-through.

### 2. Define an explicit queue-operation contract

**Priority:** P0

- **Milestone:** Replace the current single `enqueueTracks`/`setTracksToPlay` path with explicit `Play now` (replace), `Add to queue` (append), and `Play next` operations. Preserve the existing Plex track normalization and opaque `app-stream://` URLs; do not add source-specific queue behavior to the library.
- **Acceptance:** A selected album or track exposes all three intentional actions; Play now starts the selection and replaces the queue, Add appends without disturbing the current item, and Play next inserts immediately after the current item. Empty or unplayable Plex responses leave the queue unchanged and report an actionable error.
- **Likely files:** `library.js`, `library.html`, `player.js`, `preload.js`, `main.js`; add a pure queue-operation adapter/helper if Webamp's store/API needs isolation.
- **Verification:** Unit-test operation ordering and empty-input/error behavior with a fake Webamp queue; E2E-select an album, append a second album, insert a track next, then confirm playback order and current-track continuity in the Winamp playlist.

### 3. Persist the queue and current playback identity, not just window/panel state

**Priority:** P0

- **Milestone:** Extend the existing versioned `session-state.json` contract to store a sanitized queue, current track identity, position, and safe paused/resume state. Persist Plex server identity plus rating keys and metadata needed to rebuild streams rather than treating `app-stream://` URLs as durable identifiers.
- **Acceptance:** Relaunching with a populated queue restores queue order, current item, position, volume, shuffle, and repeat without unexpected autoplay; expired stream URLs are rebuilt from Plex identity or shown as unavailable; malformed/old state falls back without blocking launch; writes remain atomic.
- **Likely files:** `session-state.js`, `main.js`, `player.js`, `preload.js`, `test/session-state.test.js`; add a focused queue/session test module rather than testing Electron globals directly.
- **Verification:** Unit-test normalization, migration, corruption recovery, URL non-persistence, and queue ordering; manual/E2E kill-and-relaunch while paused and during a queue, including a disconnected-server case.

### 4. Make search results and library browsing scale without losing context

**Priority:** P1

- **Milestone:** After queue semantics are stable, add abortable/debounced request ownership and a bounded rendering strategy for large artist/result sets, while preserving the v0.5.0 tree's expanded selection where the query/server context is unchanged.
- **Acceptance:** A stale search or artist/discography response cannot overwrite a newer query or server; a 2,500+ artist library does not render unbounded DOM nodes; keyboard focus and the selected artist/tree branch survive ordinary navigation; empty, partial, and failed states remain distinct.
- **Likely files:** `library.js`, `library.html`, `search-tree.js`, `test/search-tree.test.js`; use `AbortController` only where the existing IPC/request layer can actually cancel it, otherwise retain generation guards and document that limitation.
- **Verification:** Extend pure tree tests for selection/focus preservation and bounded rows; E2E rapidly change queries and servers, expand an artist while requests resolve out of order, and browse a large fixture/library at fractional zoom.
