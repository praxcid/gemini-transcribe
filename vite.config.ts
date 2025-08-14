import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// Added Vitest configuration for unit tests (e.g., stream parser)

export default defineConfig({
	plugins: [sveltekit()],
	test: {
		environment: 'node',
		globals: true,
		include: ['src/**/*.{test,spec}.{js,ts}']
	}
});
