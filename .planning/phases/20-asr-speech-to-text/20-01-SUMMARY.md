---
phase: 20-asr-speech-to-text
plan: 01
subsystem: electron-main
tags: [electron, media-permission, audio, asr, microphone]

# Dependency graph
requires: []
provides:
  - shouldAllowMediaPermission function (renamed from shouldAllowCameraPermission)
  - MediaPermissionDecisionInput interface (renamed from CameraPermissionDecisionInput)
  - Audio-only media permission allowed from main window (Phase 20 ASR mic)
  - Video-only media permission preserved (Phase 18 camera unaffected)
  - Video+audio combined permission allowed (forward compatibility)
affects:
  - 20-02 (ChatInput mic button calls navigator.mediaDevices.getUserMedia({ audio: true }))
  - Phase 18 (camera permission continues working via video-only path)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - Three explicit media permission allow paths: video-only, audio-only, video+audio combined
    - Case-insensitive mediaTypes matching via toLowerCase()
    - Non-main-window and non-'media' permission requests rejected at gate

key-files:
  created: []
  modified:
    - electron/main/media-permissions.ts
    - electron/main/index.ts
    - tests/unit/main-camera-permissions.test.ts

key-decisions:
  - "Interface renamed CameraPermissionDecisionInput -> MediaPermissionDecisionInput to reflect broader scope"
  - "Function renamed shouldAllowCameraPermission -> shouldAllowMediaPermission for clarity"
  - "Audio-only path added alongside existing video-only path, no mutual interference"
  - "Video+audio combined path permitted for forward compatibility despite no current consumer"

patterns-established:
  - "Media permission decision follows three-tier allow list: video-only, audio-only, combined"
  - "isMainWindowWebContents gate prevents non-main-window renderers from accessing media"

requirements-completed: [D-14, D-15]

# Metrics
duration: 8min
completed: 2026-05-12
---

# Phase 20 Plan 01: Audio Media Permission Gate Summary

**Extended Electron media permission function from camera-only to support audio (ASR microphone), with renamed interface and function for clarity.**

## Performance

- **Duration:** ~8 min
- **Started:** 2026-05-12T12:40:00Z
- **Completed:** 2026-05-12T12:48:00Z
- **Tasks:** 1 (TDD: RED test + GREEN implementation)
- **Files modified:** 3

## Accomplishments
- Renamed `CameraPermissionDecisionInput` to `MediaPermissionDecisionInput` (broader scope)
- Renamed `shouldAllowCameraPermission` to `shouldAllowMediaPermission` (clearer intent)
- Removed unconditional audio rejection guard
- Added three explicit allow paths: video-only, audio-only, video+audio combined
- Video-only path preserved (Phase 18 camera permission unchanged)
- Audio-only path added (Phase 20 ASR microphone permission)
- 9 unit tests written and passing covering all behavior specs
- Both call sites in `electron/main/index.ts` updated (setPermissionCheckHandler + setPermissionRequestHandler)
- Zero references to old function/interface names remain in codebase

## Task Commits

Each task was committed atomically:

1. **Task 1: RED - Failing tests for shouldAllowMediaPermission** - `d410d5e` (test)
2. **Task 1: GREEN - Implement renamed and extended media permission function** - `2df534d` (feat)

_TDD cycle: RED (9 failing tests) -> GREEN (9 passing, no refactor needed)_

## Files Modified
- `electron/main/media-permissions.ts` — Rewritten: renamed exports, new allow-path logic
- `electron/main/index.ts` — Updated import and both call sites to use `shouldAllowMediaPermission`
- `tests/unit/main-camera-permissions.test.ts` — Rewritten: 9 tests for new function covering all behavior specs

## Decisions Made
- **Interface rename:** `CameraPermissionDecisionInput` -> `MediaPermissionDecisionInput` to reflect that the interface now handles audio in addition to video. Plan-specified.
- **Function rename:** `shouldAllowCameraPermission` -> `shouldAllowMediaPermission` for symmetry and clarity. Plan-specified.
- **Three-path allow structure:** Rather than a unified `includes('video') || includes('audio')` approach, three explicit paths (video-only, audio-only, combined) mirror the plan's must-have truths for independent permission tracks.
- **No refactor phase needed:** Implementation was clean and direct; no code cleanup required after GREEN.

## Deviations from Plan

None - plan executed exactly as written.

## Threat Flags

None - all threat mitigations from the plan's threat model are implemented: audio permission is gated on `isMainWindowWebContents`, non-main-window renderers are rejected immediately, and audio capture is user-initiated (the permission gate is the only change in this plan; the actual capture lifecycle is in future plans).

## Issues Encountered

None. The rename was straightforward and the existing test infrastructure worked without modification. The existing test file at `tests/unit/main-camera-permissions.test.ts` was updated in place rather than creating a new file — file name retained for backward compatibility with vitest config discovery.

## Self-Check: PASSED

---
*Phase: 20-asr-speech-to-text*
*Completed: 2026-05-12*
