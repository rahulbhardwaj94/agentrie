import type { Config } from 'jest';

/**
 * Jest runs under CommonJS via ts-jest. This avoids the well-known ESM friction
 * with NestJS decorators + reflect-metadata + ts-jest (see README "Deviations").
 */
const config: Config = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  roots: ['<rootDir>/src', '<rootDir>/test'],
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: 'tsconfig.json',
      },
    ],
  },
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  collectCoverageFrom: ['src/**/*.ts'],
  coverageDirectory: './coverage',
  testEnvironment: 'node',
  // Some suites talk to dockerized Redis/Mongo/LocalStack; give them room.
  testTimeout: 30000,
};

export default config;
