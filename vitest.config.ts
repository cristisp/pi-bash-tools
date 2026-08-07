import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		environment: 'node',
		include: ['test/**/*.test.ts'],
		setupFiles: ['test/setup.ts'],
		coverage: {
			provider: 'v8',
			include: ['index.ts', 'src/*.ts'],
			exclude: ['vitest.config.ts'],
			thresholds: {
				statements: 85,
				branches: 70,
				functions: 85,
				lines: 85,
			},
		},
	},
});
