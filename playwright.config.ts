import { defineConfig } from '@playwright/test';
const channel = process.env.E2E_BROWSER_CHANNEL;
if (channel && !['msedge','chrome'].includes(channel)) throw new Error('Unsupported E2E browser channel');
export default defineConfig({
  testDir:'test-e2e', testMatch:'*.spec.ts', workers:1,fullyParallel:false,retries:0,timeout:60000,
  globalTeardown:'./test-e2e/stop.ts',
  expect:{ timeout:10000 }, reporter:'list',outputDir:'.local/e2e/results',
  use:{ baseURL:'http://127.0.0.1:4100',headless:true,actionTimeout:10000,
    ...(channel ? { channel } : {}),trace:'retain-on-failure',screenshot:'only-on-failure' },
  webServer:{ command:'node dist/test-e2e/server.js',url:'http://127.0.0.1:4100/health/ready',
    reuseExistingServer:false,timeout:30000 },
});
