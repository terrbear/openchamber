import React from 'react';

// The paused-session feature (pausedSessions/resumeSession/unpauseSession) was
// a local-only addition that depended on the now-deleted useSessionStore.
// The upstream sync layer has no equivalent. The banner is disabled until the
// feature is ported to the new sync architecture.
export const PausedSessionBanner: React.FC<{ sessionId: string }> = () => {
    return null;
};
