import '@testing-library/jest-dom/vitest';

// Mock localStorage for tests
const createMockStorage = (): Storage => {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;
};

Object.defineProperty(globalThis, 'localStorage', {
  value: createMockStorage(),
  writable: true,
});

Object.defineProperty(globalThis, 'sessionStorage', {
  value: createMockStorage(),
  writable: true,
});
