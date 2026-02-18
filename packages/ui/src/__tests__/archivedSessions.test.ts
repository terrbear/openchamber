import { describe, it, expect, beforeEach, vi } from 'vitest';

// We need to test the archivedSessions module, but it uses getSafeStorage which
// is a singleton. We'll mock the storage module.

// Reset the module state before each test by dynamically importing
let archivedSessions: typeof import('@/lib/archivedSessions');

// Create a fresh mock storage for each test
const createMockStorage = () => {
  const store = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      store.delete(key);
    }),
    clear: vi.fn(() => {
      store.clear();
    }),
    key: vi.fn((index: number) => Array.from(store.keys())[index] ?? null),
    get length() {
      return store.size;
    },
    _store: store,
  };
};

let mockStorage: ReturnType<typeof createMockStorage>;

vi.mock('@/stores/utils/safeStorage', () => ({
  getSafeStorage: () => mockStorage,
}));

describe('archivedSessions', () => {
  beforeEach(async () => {
    mockStorage = createMockStorage();
    vi.resetModules();
    archivedSessions = await import('@/lib/archivedSessions');
  });

  describe('getArchivedSessions', () => {
    it('returns empty object when storage is empty', () => {
      const result = archivedSessions.getArchivedSessions();
      expect(result).toEqual({});
    });

    it('returns empty object when storage contains null', () => {
      mockStorage._store.set('oc.sessions.archived', 'null');
      const result = archivedSessions.getArchivedSessions();
      expect(result).toEqual({});
    });

    it('returns empty object when storage contains invalid JSON', () => {
      mockStorage._store.set('oc.sessions.archived', 'not json');
      const result = archivedSessions.getArchivedSessions();
      expect(result).toEqual({});
    });

    it('returns empty object when storage contains array', () => {
      mockStorage._store.set('oc.sessions.archived', '["array"]');
      const result = archivedSessions.getArchivedSessions();
      expect(result).toEqual({});
    });

    it('parses valid data correctly', () => {
      const data = {
        '/path/to/project': ['session-1', 'session-2'],
        '/another/path': ['session-3'],
      };
      mockStorage._store.set('oc.sessions.archived', JSON.stringify(data));
      const result = archivedSessions.getArchivedSessions();
      expect(result).toEqual(data);
    });

    it('filters out non-string session IDs', () => {
      const data = {
        '/path': ['valid', 123, null, 'also-valid'],
      };
      mockStorage._store.set('oc.sessions.archived', JSON.stringify(data));
      const result = archivedSessions.getArchivedSessions();
      expect(result).toEqual({
        '/path': ['valid', 'also-valid'],
      });
    });

    it('filters out directories with no valid session IDs', () => {
      const data = {
        '/path': [123, null],
        '/other': ['valid'],
      };
      mockStorage._store.set('oc.sessions.archived', JSON.stringify(data));
      const result = archivedSessions.getArchivedSessions();
      expect(result).toEqual({
        '/other': ['valid'],
      });
    });

    it('filters out non-array values for directories', () => {
      const data = {
        '/path': 'not-an-array',
        '/other': ['valid'],
      };
      mockStorage._store.set('oc.sessions.archived', JSON.stringify(data));
      const result = archivedSessions.getArchivedSessions();
      expect(result).toEqual({
        '/other': ['valid'],
      });
    });
  });

  describe('archiveSession', () => {
    it('adds session to empty storage', () => {
      archivedSessions.archiveSession('session-1', '/project');
      const stored = JSON.parse(mockStorage._store.get('oc.sessions.archived') ?? '{}');
      expect(stored).toEqual({
        '/project': ['session-1'],
      });
    });

    it('adds session to existing directory', () => {
      mockStorage._store.set(
        'oc.sessions.archived',
        JSON.stringify({ '/project': ['session-1'] })
      );
      archivedSessions.archiveSession('session-2', '/project');
      const stored = JSON.parse(mockStorage._store.get('oc.sessions.archived') ?? '{}');
      expect(stored).toEqual({
        '/project': ['session-1', 'session-2'],
      });
    });

    it('adds session to new directory', () => {
      mockStorage._store.set(
        'oc.sessions.archived',
        JSON.stringify({ '/project1': ['session-1'] })
      );
      archivedSessions.archiveSession('session-2', '/project2');
      const stored = JSON.parse(mockStorage._store.get('oc.sessions.archived') ?? '{}');
      expect(stored).toEqual({
        '/project1': ['session-1'],
        '/project2': ['session-2'],
      });
    });

    it('does not duplicate session ID', () => {
      mockStorage._store.set(
        'oc.sessions.archived',
        JSON.stringify({ '/project': ['session-1'] })
      );
      archivedSessions.archiveSession('session-1', '/project');
      const stored = JSON.parse(mockStorage._store.get('oc.sessions.archived') ?? '{}');
      expect(stored).toEqual({
        '/project': ['session-1'],
      });
    });
  });

  describe('unarchiveSession', () => {
    it('removes session from storage', () => {
      mockStorage._store.set(
        'oc.sessions.archived',
        JSON.stringify({ '/project': ['session-1', 'session-2'] })
      );
      archivedSessions.unarchiveSession('session-1', '/project');
      const stored = JSON.parse(mockStorage._store.get('oc.sessions.archived') ?? '{}');
      expect(stored).toEqual({
        '/project': ['session-2'],
      });
    });

    it('removes directory when last session is unarchived', () => {
      mockStorage._store.set(
        'oc.sessions.archived',
        JSON.stringify({ '/project': ['session-1'] })
      );
      archivedSessions.unarchiveSession('session-1', '/project');
      const stored = JSON.parse(mockStorage._store.get('oc.sessions.archived') ?? '{}');
      expect(stored).toEqual({});
    });

    it('does nothing when session is not in storage', () => {
      mockStorage._store.set(
        'oc.sessions.archived',
        JSON.stringify({ '/project': ['session-1'] })
      );
      archivedSessions.unarchiveSession('session-999', '/project');
      const stored = JSON.parse(mockStorage._store.get('oc.sessions.archived') ?? '{}');
      expect(stored).toEqual({
        '/project': ['session-1'],
      });
    });

    it('does nothing when directory is not in storage', () => {
      mockStorage._store.set(
        'oc.sessions.archived',
        JSON.stringify({ '/project': ['session-1'] })
      );
      archivedSessions.unarchiveSession('session-1', '/other');
      const stored = JSON.parse(mockStorage._store.get('oc.sessions.archived') ?? '{}');
      expect(stored).toEqual({
        '/project': ['session-1'],
      });
    });
  });

  describe('isSessionArchived', () => {
    it('returns true when session is archived', () => {
      mockStorage._store.set(
        'oc.sessions.archived',
        JSON.stringify({ '/project': ['session-1'] })
      );
      const result = archivedSessions.isSessionArchived('session-1', '/project');
      expect(result).toBe(true);
    });

    it('returns false when session is not archived', () => {
      mockStorage._store.set(
        'oc.sessions.archived',
        JSON.stringify({ '/project': ['session-1'] })
      );
      const result = archivedSessions.isSessionArchived('session-2', '/project');
      expect(result).toBe(false);
    });

    it('returns false when directory is not in storage', () => {
      mockStorage._store.set(
        'oc.sessions.archived',
        JSON.stringify({ '/project': ['session-1'] })
      );
      const result = archivedSessions.isSessionArchived('session-1', '/other');
      expect(result).toBe(false);
    });

    it('returns false when storage is empty', () => {
      const result = archivedSessions.isSessionArchived('session-1', '/project');
      expect(result).toBe(false);
    });
  });

  describe('subscribe', () => {
    it('calls listener when archive changes', () => {
      const listener = vi.fn();
      archivedSessions.subscribe(listener);
      archivedSessions.archiveSession('session-1', '/project');
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('calls listener when unarchive changes', () => {
      mockStorage._store.set(
        'oc.sessions.archived',
        JSON.stringify({ '/project': ['session-1'] })
      );
      const listener = vi.fn();
      archivedSessions.subscribe(listener);
      archivedSessions.unarchiveSession('session-1', '/project');
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('stops calling listener after unsubscribe', () => {
      const listener = vi.fn();
      const unsubscribe = archivedSessions.subscribe(listener);
      archivedSessions.archiveSession('session-1', '/project');
      expect(listener).toHaveBeenCalledTimes(1);

      unsubscribe();
      archivedSessions.archiveSession('session-2', '/project');
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('supports multiple listeners', () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();
      archivedSessions.subscribe(listener1);
      archivedSessions.subscribe(listener2);
      archivedSessions.archiveSession('session-1', '/project');
      expect(listener1).toHaveBeenCalledTimes(1);
      expect(listener2).toHaveBeenCalledTimes(1);
    });

    it('continues notifying other listeners if one throws', () => {
      const listener1 = vi.fn(() => {
        throw new Error('test error');
      });
      const listener2 = vi.fn();
      archivedSessions.subscribe(listener1);
      archivedSessions.subscribe(listener2);
      archivedSessions.archiveSession('session-1', '/project');
      expect(listener1).toHaveBeenCalledTimes(1);
      expect(listener2).toHaveBeenCalledTimes(1);
    });
  });
});
