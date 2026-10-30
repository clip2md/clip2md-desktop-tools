import { defineConfig } from 'vitest/config';
import path from 'node:path';
export default defineConfig({resolve:{alias:{obsidian:path.resolve(import.meta.dirname,'src/obsidian-test-stub.ts')}},test:{environment:'jsdom',globals:true}});
