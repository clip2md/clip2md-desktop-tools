import obsidianmd from 'eslint-plugin-obsidianmd';

export default [
    { ignores: ['node_modules/**', 'main.js', 'src/**/*.test.ts', 'src/obsidian-test-stub.ts', 'scripts/**', '*.mjs'] },
    ...obsidianmd.configs.recommended,
    { files: ['src/**/*.ts'], languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } }, rules: {
        // Sentence case applies to English prose; Chinese UI and exact credential placeholders have no sentence casing.
        'obsidianmd/ui/sentence-case': ['warn', { ignoreWords: ['Clip2MD'], ignoreRegex: ['[\\u3400-\\u9fff]', '^clip2md_', '^API Key$'] }],
    } },
    // These modules validate external site/CLI/Electron DTOs at runtime. The
    // upstream adapters intentionally inspect partially known source shapes.
    { files: ['src/adapters/**/*.ts', 'src/auth.ts', 'src/page-source.ts', 'src/comments.ts', 'src/tools.ts', 'src/collector.ts'], rules: {
        '@typescript-eslint/no-explicit-any': 'off',
        '@typescript-eslint/no-unsafe-assignment': 'off', '@typescript-eslint/no-unsafe-member-access': 'off',
        '@typescript-eslint/no-unsafe-call': 'off', '@typescript-eslint/no-unsafe-argument': 'off', '@typescript-eslint/no-unsafe-return': 'off',
        '@typescript-eslint/no-base-to-string': 'off', '@typescript-eslint/prefer-promise-reject-errors': 'off',
        '@typescript-eslint/unbound-method': 'off', '@typescript-eslint/no-require-imports': 'off',
        'obsidianmd/prefer-window-timers': 'off', 'obsidianmd/prefer-create-el': 'off', 'obsidianmd/no-global-this': 'off',
    } },
];
