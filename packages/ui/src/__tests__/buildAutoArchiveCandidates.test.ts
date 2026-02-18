import { describe, it, expect } from 'vitest';
import { buildAutoArchiveCandidates } from '@/hooks/useSessionAutoArchive';
import type { Session } from '@opencode-ai/sdk/v2';

const DAY_MS = 24 * 60 * 60 * 1000;

// Helper to create a mock session
const createSession = (
  overrides: Partial<Omit<Session, 'time'>> & {
    id: string;
    time?: { created: number; updated?: number };
  }
): Session => ({
  id: overrides.id,
  slug: overrides.slug ?? 'test-slug',
  projectID: overrides.projectID ?? 'project-1',
  directory: overrides.directory ?? '/test',
  title: overrides.title ?? 'Test Session',
  version: overrides.version ?? '1.0.0',
  share: overrides.share,
  time: {
    created: overrides.time?.created ?? Date.now(),
    updated: overrides.time?.updated ?? overrides.time?.created ?? Date.now(),
  },
});

describe('buildAutoArchiveCandidates', () => {
  const now = Date.now();
  const moreThan24HoursAgo = now - DAY_MS - 1000;
  const lessThan24HoursAgo = now - DAY_MS + 1000;

  describe('basic filtering', () => {
    it('returns empty array when sessions is empty', () => {
      const result = buildAutoArchiveCandidates({
        sessions: [],
        currentSessionId: null,
        busySessionIds: new Set(),
        now,
      });
      expect(result).toEqual([]);
    });

    it('returns empty array when sessions is not an array', () => {
      const result = buildAutoArchiveCandidates({
        sessions: null as unknown as Session[],
        currentSessionId: null,
        busySessionIds: new Set(),
        now,
      });
      expect(result).toEqual([]);
    });

    it('filters out sessions without id', () => {
      const sessions = [
        createSession({ id: 'valid', time: { created: moreThan24HoursAgo } }),
        { title: 'No ID', time: { created: moreThan24HoursAgo, updated: moreThan24HoursAgo } } as Session,
      ];
      const result = buildAutoArchiveCandidates({
        sessions,
        currentSessionId: null,
        busySessionIds: new Set(),
        now,
      });
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('valid');
    });
  });

  describe('current session exclusion', () => {
    it('excludes the current session', () => {
      const sessions = [
        createSession({ id: 'current', time: { created: moreThan24HoursAgo } }),
        createSession({ id: 'other', time: { created: moreThan24HoursAgo } }),
      ];
      const result = buildAutoArchiveCandidates({
        sessions,
        currentSessionId: 'current',
        busySessionIds: new Set(),
        now,
      });
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('other');
    });

    it('includes all sessions when currentSessionId is null', () => {
      const sessions = [
        createSession({ id: 's1', time: { created: moreThan24HoursAgo } }),
        createSession({ id: 's2', time: { created: moreThan24HoursAgo } }),
      ];
      const result = buildAutoArchiveCandidates({
        sessions,
        currentSessionId: null,
        busySessionIds: new Set(),
        now,
      });
      expect(result).toHaveLength(2);
    });
  });

  describe('shared session exclusion', () => {
    it('excludes shared sessions', () => {
      const sessions = [
        createSession({
          id: 'shared',
          time: { created: moreThan24HoursAgo },
          share: { url: 'https://example.com/share' },
        }),
        createSession({ id: 'normal', time: { created: moreThan24HoursAgo } }),
      ];
      const result = buildAutoArchiveCandidates({
        sessions,
        currentSessionId: null,
        busySessionIds: new Set(),
        now,
      });
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('normal');
    });
  });

  describe('busy session exclusion', () => {
    it('excludes busy sessions', () => {
      const sessions = [
        createSession({ id: 'busy', time: { created: moreThan24HoursAgo } }),
        createSession({ id: 'idle', time: { created: moreThan24HoursAgo } }),
      ];
      const result = buildAutoArchiveCandidates({
        sessions,
        currentSessionId: null,
        busySessionIds: new Set(['busy']),
        now,
      });
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('idle');
    });

    it('excludes multiple busy sessions', () => {
      const sessions = [
        createSession({ id: 's1', time: { created: moreThan24HoursAgo } }),
        createSession({ id: 's2', time: { created: moreThan24HoursAgo } }),
        createSession({ id: 's3', time: { created: moreThan24HoursAgo } }),
      ];
      const result = buildAutoArchiveCandidates({
        sessions,
        currentSessionId: null,
        busySessionIds: new Set(['s1', 's3']),
        now,
      });
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('s2');
    });
  });

  describe('inactivity threshold', () => {
    it('includes sessions inactive for more than 24 hours', () => {
      const sessions = [
        createSession({ id: 'old', time: { created: moreThan24HoursAgo } }),
      ];
      const result = buildAutoArchiveCandidates({
        sessions,
        currentSessionId: null,
        busySessionIds: new Set(),
        now,
      });
      expect(result).toHaveLength(1);
    });

    it('excludes sessions inactive for less than 24 hours', () => {
      const sessions = [
        createSession({ id: 'recent', time: { created: lessThan24HoursAgo } }),
      ];
      const result = buildAutoArchiveCandidates({
        sessions,
        currentSessionId: null,
        busySessionIds: new Set(),
        now,
      });
      expect(result).toHaveLength(0);
    });

    it('uses updated time over created time', () => {
      const sessions = [
        createSession({
          id: 'updated-recently',
          time: { created: moreThan24HoursAgo, updated: lessThan24HoursAgo },
        }),
      ];
      const result = buildAutoArchiveCandidates({
        sessions,
        currentSessionId: null,
        busySessionIds: new Set(),
        now,
      });
      expect(result).toHaveLength(0);
    });

    it('includes session when updated time is also old', () => {
      const sessions = [
        createSession({
          id: 'all-old',
          time: { created: moreThan24HoursAgo, updated: moreThan24HoursAgo },
        }),
      ];
      const result = buildAutoArchiveCandidates({
        sessions,
        currentSessionId: null,
        busySessionIds: new Set(),
        now,
      });
      expect(result).toHaveLength(1);
    });

    it('excludes sessions with zero timestamp', () => {
      const sessions = [
        createSession({ id: 'zero', time: { created: 0, updated: 0 } }),
      ];
      const result = buildAutoArchiveCandidates({
        sessions,
        currentSessionId: null,
        busySessionIds: new Set(),
        now,
      });
      expect(result).toHaveLength(0);
    });
  });

  describe('combined filters', () => {
    it('applies all filters together', () => {
      const sessions = [
        // Should be excluded: current session
        createSession({ id: 'current', time: { created: moreThan24HoursAgo } }),
        // Should be excluded: shared
        createSession({
          id: 'shared',
          time: { created: moreThan24HoursAgo },
          share: { url: 'https://example.com' },
        }),
        // Should be excluded: busy
        createSession({ id: 'busy', time: { created: moreThan24HoursAgo } }),
        // Should be excluded: too recent
        createSession({ id: 'recent', time: { created: lessThan24HoursAgo } }),
        // Should be included
        createSession({ id: 'archivable', time: { created: moreThan24HoursAgo } }),
      ];
      const result = buildAutoArchiveCandidates({
        sessions,
        currentSessionId: 'current',
        busySessionIds: new Set(['busy']),
        now,
      });
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('archivable');
    });
  });

  describe('now parameter', () => {
    it('uses provided now value for cutoff calculation', () => {
      const customNow = 1000000000000; // Some fixed timestamp
      const sessions = [
        createSession({ id: 's1', time: { created: customNow - DAY_MS - 1000 } }),
        createSession({ id: 's2', time: { created: customNow - DAY_MS + 1000 } }),
      ];
      const result = buildAutoArchiveCandidates({
        sessions,
        currentSessionId: null,
        busySessionIds: new Set(),
        now: customNow,
      });
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('s1');
    });
  });
});
