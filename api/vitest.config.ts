import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./test/global-setup.ts'],
    include: ['test/**/*.test.ts'],
    // Files share one database, and creating a sandbox deletes every expired one, so a test
    // that expires a sandbox can race another file. Run files one at a time.
    fileParallelism: false,
  },
});
