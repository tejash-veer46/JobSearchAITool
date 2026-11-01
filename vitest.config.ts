import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tests never call the Claude API, even when .env has a key.
    env: { JOBAPPLYAI_OFFLINE: '1' },
    // The browser tests share one Chrome profile per file; keep files sequential.
    fileParallelism: false,
  },
});
