import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Lets a test read index.css as text (`?raw`); other CSS stays stubbed.
    css: { include: [/index\.css/] },
  },
});
