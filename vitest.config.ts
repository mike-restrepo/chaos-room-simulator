import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@chaos-room/shared': path.resolve(__dirname, 'packages/shared/src/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: [
      'packages/shared/test/**/*.test.ts',
      'apps/web/src/**/*.test.{ts,tsx}',
      'functions/test/**/*.unit.test.ts',
      'functions/test/build-self-contained.test.ts',
    ],
  },
});
