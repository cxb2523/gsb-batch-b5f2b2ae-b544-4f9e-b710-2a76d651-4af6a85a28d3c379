import {defineConfig} from 'vitest/config';
import {fileURLToPath} from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
    resolve: {
        alias: [
            {find: '@model', replacement: r('./src/lib/models')},
            {find: '@enum', replacement: r('./src/lib/enums')},
            {find: '@svg', replacement: r('./src/lib/svg')},
            {find: '@decorator', replacement: r('./src/lib/decorators')},
            {find: '@style', replacement: r('./src/scss')},
            {find: '@', replacement: r('./src/lib')},
        ],
    },
    test: {
        environment: 'node',
        include: ['tests/**/*.test.ts'],
    },
});
