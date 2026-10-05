import { bindings, defineConfig, exports } from 'cf/config';

export default defineConfig({
  worker: {
    name: 'calendar-opaque-alarms',
    entrypoint: './src/index.ts',
    compatibilityDate: '2026-10-05',
    workersDev: true,
    previewUrls: false,
    exports: { Alarm: exports.durableObject({ storage: 'sqlite' }) },
    env: {
      ALARMS: bindings.durableObject({ worker: 'calendar-opaque-alarms', exportName: 'Alarm' }),
      REGISTRATION_KEY: bindings.secret(),
      CALLBACK_KEY: bindings.secret(),
      CALLBACK_URL: bindings.text('https://schedule-my-agents.bennycrow91.chatgpt.site/api/alarms/wake'),
    },
    observability: { enabled: true, logs: { enabled: true, invocationLogs: false } },
  },
});
