import yml from 'eslint-plugin-yml';
import parser from 'yaml-eslint-parser';

export default [
    {
        files: ['**/*.yaml', '**/*.yml'],
        plugins: {
            yml
        },
        languageOptions: {
            parser
        },
        rules: {
            // Indentazione
            'yml/indent': ['error', 2, {
                indentBlockSequences: true,
                indicatorValueIndent: 2
            }],

            // Struttura
            'yml/no-empty-document': 'error',
            'yml/no-empty-mapping-value': 'warn',
            'yml/no-multiple-empty-lines': ['error', { max: 1 }],

            // Spaziatura
            'yml/key-spacing': ['error', {
                beforeColon: false,
                afterColon: true
            }],
            'yml/spaced-comment': ['error', 'always'],

            // Stile
            'yml/quotes': ['error', {
                prefer: 'double',
                avoidEscape: false
            }],
            'yml/block-mapping': 'error',
            'yml/block-sequence': 'error',

            // Best practices
            'yml/no-trailing-zeros': 'error',
            'yml/no-irregular-whitespace': 'error',
            'yml/plain-scalar': 'off', // Permette template Helm senza quote

            // Kubernetes/Helm specific
            'yml/no-empty-key': 'error',
            'yml/require-string-key': 'off' // Permette chiavi numeriche
        }
    },
    {
        // Ignora file e directory
        ignores: [
            '**/node_modules/**',
            '**/dist/**',
            '**/.helm/**',
            '**/charts/**/*.tgz',
            '**/.git/**',
            'pnpm-lock.yaml',
        ]
    }
];