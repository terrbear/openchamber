# Code Review — Issues to Fix

## Critical Issues

### 1. sessionStore.ts — Missing error handling for abortCurrentOperation in pauseSession
The `pauseSession` function calls `await messageStore.abortCurrentOperation(sessionId)` without error handling. If abort fails, the session gets marked paused but hasn't actually stopped.

**Fix:** Wrap in try/catch. Only store paused state if abort succeeds. On failure, throw or log error.

### 2. sessionStore.ts — Missing error handling for sendMessage in resumeSession  
The `resumeSession` function clears the paused state BEFORE calling `sendMessage`. If send fails, the pause context is lost and the user can't retry.

**Fix:** Move the `pausedSessions.delete()` call to AFTER `sendMessage` succeeds. Wrap in try/catch and preserve paused state on failure.

### 3. sessionStore.ts — Missing validation for empty providerID/modelID in pauseSession
The code allows empty strings for `providerID` and `modelID` via `|| ''`. This creates paused sessions that cannot be resumed.

**Fix:** After extracting providerID/modelID, validate they're non-empty. If missing, throw or return early with a warning.

## Warnings to Fix

### 4. sessionStore.ts — Duplicate PausedSessionInfo type definition
`PausedSessionInfo` is defined in both `sessionStore.ts` and `sessionTypes.ts`. Remove the one in `sessionStore.ts` and import from `sessionTypes.ts`.

### 5. PausedSessionBanner.tsx — Invalid typography class
Uses `typography-ui-body` which doesn't exist. Replace with `typography-meta`.

### 6. sessionStore.ts — Add validation for corrupted pausedInfo in resumeSession
Before using pausedInfo fields, validate that required fields (lastUserMessageText, providerID, modelID) are present. Clean up corrupted entries.
