/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/db/migrations/**',
    '!src/index.ts',
  ],
  coverageReporters: ['text', 'lcov'],
};
